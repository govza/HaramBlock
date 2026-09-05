import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DvrProbe, type AudioHealthSample, type PresentedSample } from '@/entrypoints/content/video/dvr/probe';
import { ATTR } from '@/utils/telemetry/attributes';
import { registerLogSink } from '@/utils/telemetry/logger';
import { METRIC, registerMetricSink } from '@/utils/telemetry/metrics';

import type { SessionFrameStore } from '@/entrypoints/content/video/dvr/frameStoreFactory';
import type { TelemetryLogRecord, TelemetryMetricRecord } from '@/utils/telemetry/records';

const captureSample = (totalMs: number) => ({
  totalMs,
  drawMs: totalMs / 2,
  transferMs: totalMs / 2,
  width: 640,
  height: 360,
});

const sample: PresentedSample = {
  mediaTime: 10,
  targetTime: 9,
  frameTimeServed: 9,
  outcome: 'new',
  presentMs: 3,
};

describe('DVR probe lifecycle', () => {
  const cleanup: (() => void)[] = [];
  let longTask: (duration: number) => void;
  let active: boolean;
  let latencyP90Ms: number;
  let audio: AudioHealthSample;
  let logs: TelemetryLogRecord[];
  let metrics: TelemetryMetricRecord[];

  const named = (name: string) => metrics.filter(record => record.name === name);
  const values = (name: string) => named(name).map(record => record.value);
  const presentMany = (probe: DvrProbe, count: number, outcome: PresentedSample['outcome'] = 'new') => {
    for (let i = 0; i < count; i++) probe.presented({ ...sample, outcome });
  };
  const captureMany = (probe: DvrProbe, count: number) => {
    for (let i = 0; i < count; i++) probe.captured(captureSample(1));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    active = true;
    latencyP90Ms = 200;
    audio = { route: 'delayLine', underruns: 0, driftMs: 0, unavailable: false };
    logs = [];
    metrics = [];
    cleanup.push(registerLogSink(record => logs.push(record)));
    cleanup.push(registerMetricSink(record => metrics.push(record)));
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        constructor(callback: PerformanceObserverCallback) {
          longTask = duration =>
            callback(
              { getEntries: () => [{ duration }] } as PerformanceObserverEntryList,
              this as unknown as PerformanceObserver,
            );
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function start(lastAnomalyAt?: number): DvrProbe {
    const store: SessionFrameStore = {
      captureMode: 'video-frame',
      kind: () => 'encoded',
      selectionReason: () => 'encoded' as const,
      demoteToRaw() {},
      push() {},
      frameAt: () => null,
      coveredMisses: () => 0,
      spanSec: () => 2,
      oldestTime: () => 8,
      newestTime: () => 10,
      bytes: () => 1024,
      setLimits() {},
      release() {},
    };
    const probe = new DvrProbe({
      sessionId: 'video-1',
      tap: () => 'tap',
      store,
      delaySec: () => 1,
      latencyP90Ms: () => latencyP90Ms,
      audio: () => audio,
      now: Date.now,
      isPlaybackActive: () => active,
      lastAnomalyAt,
    });
    cleanup.push(() => probe.stop());
    return probe;
  }

  it('exports timing samples outside frame callbacks and preserves their values', () => {
    const probe = start();
    probe.captured(captureSample(2));
    probe.presented(sample);
    probe.captured(captureSample(4));
    expect(metrics).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(metrics.filter(record => record.name === METRIC.dvrCaptureMs).map(record => record.value)).toEqual([2, 4]);
    expect(metrics.filter(record => record.name === METRIC.dvrPresentMs).map(record => record.value)).toEqual([3]);
  });

  it('reports source fps, deduped ticks, skipped frames, late ticks and capture geometry per window', () => {
    const probe = start();
    probe.captured(captureSample(2));
    probe.delivered(1.0);
    vi.setSystemTime(40);
    probe.delivered(1.04);
    vi.setSystemTime(56);
    probe.delivered(1.04);
    vi.setSystemTime(200);
    probe.delivered(1.12);
    vi.advanceTimersByTime(1000);
    expect(values(METRIC.dvrSourceFps)).toEqual([3]);
    expect(values(METRIC.dvrTicksDeduped)).toEqual([1]);
    expect(values(METRIC.dvrSourceFramesSkipped)).toEqual([1]);
    expect(values(METRIC.dvrTicksLate)).toEqual([1]);
    expect(values(METRIC.dvrCaptureWidth)).toEqual([640]);
    expect(values(METRIC.dvrCaptureHeight)).toEqual([360]);
    expect(values(METRIC.dvrTickGapMs)).toEqual([40, 144]);
    expect(values(METRIC.dvrCaptureDrawMs)).toEqual([1]);
    expect(values(METRIC.dvrCaptureTransferMs)).toEqual([1]);
    const rollup = named(METRIC.dvrTicksLate)[0]!.attributes;
    expect(rollup[ATTR.browser]).toBe('firefox');
    expect(rollup[ATTR.sessionId]).toBeUndefined();
  });

  it('records the delivery gap and media delta on the tick dump', () => {
    const probe = start();
    probe.delivered(1.0);
    vi.setSystemTime(40);
    probe.delivered(1.04);
    probe.presented(sample);
    probe.signal('underrun');
    const tick = logs.find(record => record.event === 'video.dvr.tick');
    expect(tick?.attributes[ATTR.tickWallGapMs]).toBe(40);
    expect(tick?.attributes[ATTR.tickMediaDelta]).toBeCloseTo(0.04);
  });

  it('keeps the same session cooldown when a run is stopped and restarted', () => {
    const first = start();
    first.signal('underrun');
    first.stop();
    vi.advanceTimersByTime(1000);
    const restarted = start(first.lastAnomalyAt);
    restarted.signal('store_stall');
    expect(logs.filter(record => record.event === 'video.dvr.anomaly')).toHaveLength(1);
    vi.advanceTimersByTime(9000);
    restarted.signal('store_stall');
    expect(logs.filter(record => record.event === 'video.dvr.anomaly')).toHaveLength(2);
  });

  it('reports playback_active every window and health counters only while active', () => {
    const probe = start();
    captureMany(probe, 30);
    presentMany(probe, 30);
    vi.advanceTimersByTime(1000);
    active = false;
    vi.advanceTimersByTime(1000);
    expect(values(METRIC.dvrPlaybackActive)).toEqual([1, 0]);
    expect(values(METRIC.dvrActiveWindows)).toEqual([1]);
    expect(values(METRIC.dvrHealthyWindows)).toEqual([1]);
    expect(values(METRIC.dvrVerdictMarginSec)).toEqual([1 - 0.2]);
    expect(values(METRIC.audioRouteWindows)).toEqual([1]);
  });

  it('counts dropped frames from captured minus presented ticks and marks a sub-threshold drop unhealthy', () => {
    const probe = start();
    captureMany(probe, 60);
    presentMany(probe, 51);
    presentMany(probe, 2, 'repeat');
    vi.advanceTimersByTime(1000);
    expect(values(METRIC.dvrFramesDropped)).toEqual([7]);
    expect(values(METRIC.dvrHealthyWindows)).toEqual([]);
    expect(values(METRIC.dvrFreezeWindows)).toEqual([]);
    expect(logs.filter(record => record.event === 'video.dvr.anomaly')).toEqual([]);
  });

  it('counts an active window with no new frame as a freeze', () => {
    const probe = start();
    captureMany(probe, 30);
    presentMany(probe, 30, 'repeat');
    vi.advanceTimersByTime(1000);
    expect(values(METRIC.dvrFreezeWindows)).toEqual([1]);
    expect(values(METRIC.dvrHealthyWindows)).toEqual([]);
    expect(values(METRIC.dvrFramesDropped)).toEqual([]);
  });

  it('a long task or an audio underrun makes the window unhealthy', () => {
    const probe = start();
    captureMany(probe, 30);
    presentMany(probe, 30);
    longTask(150);
    vi.advanceTimersByTime(1000);
    captureMany(probe, 30);
    presentMany(probe, 30);
    audio = { ...audio, underruns: 1 };
    vi.advanceTimersByTime(1000);
    expect(values(METRIC.dvrActiveWindows)).toEqual([1, 1]);
    expect(values(METRIC.dvrHealthyWindows)).toEqual([]);
    expect(values(METRIC.audioUnderruns)).toEqual([1]);
  });

  it('maps the audio sample onto route-tagged metrics and emits underrun deltas only', () => {
    const probe = start();
    audio = { route: 'relay', underruns: 3, driftMs: -40, unavailable: false };
    captureMany(probe, 30);
    presentMany(probe, 30);
    vi.advanceTimersByTime(1000);
    audio = { route: 'relay', underruns: 5, driftMs: 12, unavailable: false };
    captureMany(probe, 30);
    presentMany(probe, 30);
    vi.advanceTimersByTime(1000);
    audio = { route: 'unavailable', underruns: 0, driftMs: 0, unavailable: true };
    captureMany(probe, 30);
    presentMany(probe, 30);
    vi.advanceTimersByTime(1000);
    expect(values(METRIC.audioDriftMs)).toEqual([-40, 12, 0]);
    expect(named(METRIC.audioDriftMs).map(record => record.attributes[ATTR.audioRoute])).toEqual([
      'relay',
      'relay',
      'unavailable',
    ]);
    expect(values(METRIC.audioUnderruns)).toEqual([2]);
    expect(values(METRIC.audioUnavailableWindows)).toEqual([1]);
    expect(named(METRIC.audioRouteWindows).map(record => record.attributes[ATTR.audioRoute])).toEqual([
      'relay',
      'relay',
      'unavailable',
    ]);
  });

  it('rollup counters carry store and tap but never the session id', () => {
    const probe = start();
    captureMany(probe, 30);
    presentMany(probe, 30);
    probe.signal('underrun');
    vi.advanceTimersByTime(1000);
    const counters = metrics.filter(record => record.kind === 'counter');
    expect(counters.length).toBeGreaterThan(0);
    for (const record of counters) {
      expect(record.attributes[ATTR.sessionId]).toBeUndefined();
      expect(record.attributes[ATTR.dvrStore]).toBe('encoded');
      expect(record.attributes[ATTR.dvrTap]).toBe('tap');
    }
    expect(named(METRIC.dvrAnomalies).map(record => record.attributes[ATTR.dvrCause])).toEqual(['underrun']);
    for (const record of metrics.filter(r => r.kind === 'gauge')) {
      expect(record.attributes[ATTR.sessionId]).toBe('video-1');
    }
  });

  it('ignores paused or finished playback without spending the anomaly cooldown', () => {
    const probe = start();
    probe.presented(sample);
    active = false;
    longTask(150);
    vi.advanceTimersByTime(2000);
    expect(metrics.filter(record => record.name === METRIC.mainThreadLongTaskMs)).toEqual([]);
    expect(logs.filter(record => record.event === 'video.dvr.anomaly')).toEqual([]);
    active = true;
    longTask(150);
    expect(metrics.filter(record => record.name === METRIC.mainThreadLongTaskMs)).toHaveLength(1);
    expect(logs.filter(record => record.event === 'video.dvr.anomaly')).toHaveLength(1);
  });
});
