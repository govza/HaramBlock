import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DvrProbe, type PresentedSample } from '@/entrypoints/content/video/dvr/probe';
import { registerLogSink } from '@/utils/telemetry/logger';
import { METRIC, registerMetricSink } from '@/utils/telemetry/metrics';

import type { SessionFrameStore } from '@/entrypoints/content/video/dvr/frameStoreFactory';
import type { TelemetryLogRecord, TelemetryMetricRecord } from '@/utils/telemetry/records';

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
  let logs: TelemetryLogRecord[];
  let metrics: TelemetryMetricRecord[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    active = true;
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
      now: Date.now,
      isPlaybackActive: () => active,
      lastAnomalyAt,
    });
    cleanup.push(() => probe.stop());
    return probe;
  }

  it('exports timing samples outside frame callbacks and preserves their values', () => {
    const probe = start();
    probe.captured(2);
    probe.presented(sample);
    probe.captured(4);
    expect(metrics).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(metrics.filter(record => record.name === METRIC.dvrCaptureMs).map(record => record.value)).toEqual([2, 4]);
    expect(metrics.filter(record => record.name === METRIC.dvrPresentMs).map(record => record.value)).toEqual([3]);
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
