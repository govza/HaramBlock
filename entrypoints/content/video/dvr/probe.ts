import {
  ANOMALY_LONG_TASK_MS,
  droppedFrames,
  DvrAnomalyDetector,
  DvrTickRing,
  isFrozen,
  isHealthy,
  SourceClock,
  type DvrAnomalyCause,
  type DvrTickRecord,
  type HealthWindow,
} from '@/entrypoints/content/video/dvr/probeCore';
import { IS_CHROME } from '@/utils/constants/environment';
import { generateNonce } from '@/utils/nonce';
import { ATTR, getLogger, METRIC, recordCounter, recordGauge, recordHistogram } from '@/utils/telemetry';

import type { SessionFrameStore } from '@/entrypoints/content/video/dvr/frameStoreFactory';

const log = getLogger('dvrProbe');

export const PROBE_WINDOW_MS = 1000;
export const TICK_RING_RETENTION_MS = 5000;
const TICK_RING_CAPACITY = 400;

export type DvrTapKind = 'tap' | 'rvfc';

export type PresentOutcome = 'new' | 'repeat' | 'miss';

export interface CaptureSample {
  totalMs: number;
  drawMs: number;
  transferMs: number;
  width: number;
  height: number;
}

const BROWSER_NAME = IS_CHROME ? 'chrome' : 'firefox';

export interface PresentedSample {
  mediaTime: number;
  targetTime: number;
  frameTimeServed: number;
  outcome: PresentOutcome;
  presentMs: number;
}

export type AudioHealthRoute = 'none' | 'pending' | 'delayLine' | 'relay' | 'deferred' | 'unavailable';

export interface AudioHealthSample {
  route: AudioHealthRoute;
  underruns: number;
  driftMs: number;
  unavailable: boolean;
}

export interface DvrProbeOptions {
  sessionId: string;
  tap: () => DvrTapKind;
  store: SessionFrameStore;
  delaySec: () => number;
  latencyP90Ms: () => number;
  audio: () => AudioHealthSample;
  now: () => number;
  isPlaybackActive: () => boolean;
  lastAnomalyAt?: number;
}

interface LongTaskListener {
  (durationMs: number): void;
}

const longTaskListeners = new Set<LongTaskListener>();
let longTaskObserver: PerformanceObserver | null = null;

function watchLongTasks(listener: LongTaskListener): () => void {
  longTaskListeners.add(listener);
  if (!longTaskObserver && typeof PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          for (const active of longTaskListeners) active(entry.duration);
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      longTaskObserver = null;
    }
  }
  return () => {
    longTaskListeners.delete(listener);
    if (longTaskListeners.size === 0) {
      longTaskObserver?.disconnect();
      longTaskObserver = null;
    }
  };
}

export class DvrProbe {
  private readonly ring = new DvrTickRing(TICK_RING_CAPACITY);
  private readonly detector: DvrAnomalyDetector;
  // Bounded scratch storage: no metric records or attribute objects in frame callbacks.
  // Keep up to 1024 timings per one-second window; excess samples are dropped if flushing stalls.
  private readonly captureSamples = new Float64Array(1024);
  private readonly captureDrawSamples = new Float64Array(1024);
  private readonly captureTransferSamples = new Float64Array(1024);
  private readonly presentSamples = new Float64Array(1024);
  private readonly tickGapSamples = new Float64Array(1024);
  private captureSampleCount = 0;
  private presentSampleCount = 0;
  private tickGapSampleCount = 0;
  private readonly sourceClock = new SourceClock();
  private windowSourceFrames = 0;
  private windowTicksDeduped = 0;
  private windowSourceFramesSkipped = 0;
  private windowTicksLate = 0;
  private lastMediaDelta = 0;
  private lastWallGapMs = 0;
  private lastCaptureWidth = 0;
  private lastCaptureHeight = 0;
  private windowCaptured = 0;
  private windowPresented = 0;
  private windowRepeats = 0;
  private windowLongestTaskMs = 0;
  private lastAudioUnderruns: number | null = null;
  private lastCaptureMs = 0;
  private cachedAttributes: Record<string, string> | null = null;
  private cachedRollupAttributes: Record<string, string> | null = null;
  private readonly health: HealthWindow = {
    captured: 0,
    presented: 0,
    repeats: 0,
    longestTaskMs: 0,
    audioUnderruns: 0,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private unwatchLongTasks: (() => void) | null = null;

  constructor(private readonly opts: DvrProbeOptions) {
    this.detector = new DvrAnomalyDetector(opts.lastAnomalyAt);
    this.unwatchLongTasks = watchLongTasks(this.onLongTask);
    this.timer = setInterval(this.flushWindow, PROBE_WINDOW_MS);
  }

  captured(sample: CaptureSample): void {
    this.windowCaptured++;
    this.lastCaptureMs = sample.totalMs;
    this.lastCaptureWidth = sample.width;
    this.lastCaptureHeight = sample.height;
    if (this.captureSampleCount < this.captureSamples.length) {
      this.captureSamples[this.captureSampleCount] = sample.totalMs;
      this.captureDrawSamples[this.captureSampleCount] = sample.drawMs;
      this.captureTransferSamples[this.captureSampleCount] = sample.transferMs;
      this.captureSampleCount++;
    }
  }

  delivered(mediaTime: number): void {
    const delivery = this.sourceClock.observe(mediaTime, this.opts.now());
    this.lastMediaDelta = delivery.mediaDelta;
    this.lastWallGapMs = delivery.wallGapMs;
    if (delivery.kind === 'duplicate') {
      this.windowTicksDeduped++;
      return;
    }
    if (delivery.kind === 'seek') return;
    this.windowSourceFrames++;
    this.windowSourceFramesSkipped += delivery.framesSkipped;
    if (delivery.late) this.windowTicksLate++;
    if (delivery.wallGapMs > 0 && this.tickGapSampleCount < this.tickGapSamples.length) {
      this.tickGapSamples[this.tickGapSampleCount++] = delivery.wallGapMs;
    }
  }

  presented(sample: PresentedSample): void {
    if (!this.opts.isPlaybackActive()) return;
    if (sample.outcome === 'new') this.windowPresented++;
    else if (sample.outcome === 'repeat') this.windowRepeats++;
    const record = this.ring.next();
    record.wallTs = this.opts.now();
    record.wallGapMs = this.lastWallGapMs;
    record.mediaTime = sample.mediaTime;
    record.mediaDelta = this.lastMediaDelta;
    record.targetTime = sample.targetTime;
    record.frameTimeServed = sample.frameTimeServed;
    record.repeat = sample.outcome === 'repeat';
    record.captureMs = this.lastCaptureMs;
    record.presentMs = sample.presentMs;
    record.storeCoveredMisses = this.opts.store.coveredMisses();
    if (this.presentSampleCount < this.presentSamples.length) {
      this.presentSamples[this.presentSampleCount++] = sample.presentMs;
    }
  }

  signal(cause: Extract<DvrAnomalyCause, 'underrun' | 'store_stall'>): void {
    this.dump(this.detector.signal(cause, this.opts.now()));
  }

  get lastAnomalyAt(): number {
    return this.detector.lastDumpAt;
  }

  stop(): void {
    this.flushHistograms(this.attributes());
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unwatchLongTasks?.();
    this.unwatchLongTasks = null;
  }

  private readonly onLongTask = (durationMs: number): void => {
    if (!this.opts.isPlaybackActive()) return;
    if (durationMs > this.windowLongestTaskMs) this.windowLongestTaskMs = durationMs;
    recordHistogram(METRIC.mainThreadLongTaskMs, durationMs, this.attributes());
    if (durationMs <= ANOMALY_LONG_TASK_MS) return;
    this.dump(this.detector.observeLongTask(durationMs, this.opts.now()), {
      [ATTR.dvrAnomalyLongTaskMs]: durationMs,
    });
  };

  private readonly flushWindow = (): void => {
    const attributes = this.attributes();
    this.flushHistograms(attributes);
    const captured = this.windowCaptured;
    const presented = this.windowPresented;
    const repeats = this.windowRepeats;
    const longestTaskMs = this.windowLongestTaskMs;
    const sourceFrames = this.windowSourceFrames;
    const ticksDeduped = this.windowTicksDeduped;
    const sourceFramesSkipped = this.windowSourceFramesSkipped;
    const ticksLate = this.windowTicksLate;
    this.windowCaptured = 0;
    this.windowPresented = 0;
    this.windowRepeats = 0;
    this.windowLongestTaskMs = 0;
    this.windowSourceFrames = 0;
    this.windowTicksDeduped = 0;
    this.windowSourceFramesSkipped = 0;
    this.windowTicksLate = 0;
    const ticks = presented + repeats;
    const active = this.opts.isPlaybackActive();
    const delaySec = this.opts.delaySec();
    recordGauge(METRIC.dvrCapturedFps, captured, attributes);
    recordGauge(METRIC.dvrPresentedFps, presented, attributes);
    recordGauge(METRIC.dvrSourceFps, sourceFrames, attributes);
    recordGauge(METRIC.dvrTicksDeduped, ticksDeduped, attributes);
    recordGauge(METRIC.dvrCaptureWidth, this.lastCaptureWidth, attributes);
    recordGauge(METRIC.dvrCaptureHeight, this.lastCaptureHeight, attributes);
    recordGauge(METRIC.dvrFrameRepeatRatio, ticks === 0 ? 0 : repeats / ticks, attributes);
    recordGauge(METRIC.dvrDelaySec, delaySec, attributes);
    recordGauge(METRIC.dvrRingBytes, this.opts.store.bytes(), attributes);
    recordGauge(METRIC.dvrRingSpanSec, this.opts.store.spanSec(), attributes);
    recordGauge(METRIC.dvrPlaybackActive, active ? 1 : 0, attributes);
    if (!active) {
      this.detector.resetWindows();
      return;
    }
    recordGauge(METRIC.dvrVerdictMarginSec, delaySec - this.opts.latencyP90Ms() / 1000, attributes);
    const audioUnderruns = this.flushAudio(attributes);
    const { health } = this;
    health.captured = captured;
    health.presented = presented;
    health.repeats = repeats;
    health.longestTaskMs = longestTaskMs;
    health.audioUnderruns = audioUnderruns;
    const rollup = this.rollupAttributes();
    recordCounter(METRIC.dvrActiveWindows, 1, rollup);
    recordCounter(METRIC.dvrHealthyWindows, isHealthy(health) ? 1 : 0, rollup);
    recordCounter(METRIC.dvrFreezeWindows, isFrozen(health) ? 1 : 0, rollup);
    recordCounter(METRIC.dvrFramesDropped, droppedFrames(health), rollup);
    recordCounter(METRIC.dvrSourceFramesSkipped, sourceFramesSkipped, rollup);
    recordCounter(METRIC.dvrTicksLate, ticksLate, rollup);
    this.dump(this.detector.observeWindow({ captured, presented, nowMs: this.opts.now() }));
  };

  private flushAudio(attributes: Record<string, string>): number {
    const sample = this.opts.audio();
    const underruns = this.lastAudioUnderruns === null ? 0 : Math.max(0, sample.underruns - this.lastAudioUnderruns);
    this.lastAudioUnderruns = sample.underruns;
    const routed = { ...this.rollupAttributes(), [ATTR.audioRoute]: sample.route };
    recordGauge(METRIC.audioDriftMs, sample.driftMs, { ...attributes, [ATTR.audioRoute]: sample.route });
    recordCounter(METRIC.audioRouteWindows, 1, routed);
    recordCounter(METRIC.audioUnderruns, underruns, routed);
    recordCounter(METRIC.audioUnavailableWindows, sample.unavailable ? 1 : 0, routed);
    return underruns;
  }

  private flushHistograms(attributes: Record<string, string>): void {
    for (let i = 0; i < this.captureSampleCount; i++) {
      recordHistogram(METRIC.dvrCaptureMs, this.captureSamples[i] ?? 0, attributes);
      recordHistogram(METRIC.dvrCaptureDrawMs, this.captureDrawSamples[i] ?? 0, attributes);
      recordHistogram(METRIC.dvrCaptureTransferMs, this.captureTransferSamples[i] ?? 0, attributes);
    }
    for (let i = 0; i < this.presentSampleCount; i++) {
      recordHistogram(METRIC.dvrPresentMs, this.presentSamples[i] ?? 0, attributes);
    }
    for (let i = 0; i < this.tickGapSampleCount; i++) {
      recordHistogram(METRIC.dvrTickGapMs, this.tickGapSamples[i] ?? 0, attributes);
    }
    this.captureSampleCount = 0;
    this.presentSampleCount = 0;
    this.tickGapSampleCount = 0;
  }

  private attributes(): Record<string, string> {
    const store = this.opts.store.kind();
    const tap = this.opts.tap();
    const cached = this.cachedAttributes;
    if (cached && cached[ATTR.dvrStore] === store && cached[ATTR.dvrTap] === tap) return cached;
    this.cachedAttributes = {
      [ATTR.sessionId]: this.opts.sessionId,
      [ATTR.browser]: BROWSER_NAME,
      [ATTR.dvrStore]: store,
      [ATTR.dvrTap]: tap,
    };
    return this.cachedAttributes;
  }

  private rollupAttributes(): Record<string, string> {
    const store = this.opts.store.kind();
    const tap = this.opts.tap();
    const cached = this.cachedRollupAttributes;
    if (cached && cached[ATTR.dvrStore] === store && cached[ATTR.dvrTap] === tap) return cached;
    this.cachedRollupAttributes = { [ATTR.browser]: BROWSER_NAME, [ATTR.dvrStore]: store, [ATTR.dvrTap]: tap };
    return this.cachedRollupAttributes;
  }

  private dump(cause: DvrAnomalyCause | null, extra: Record<string, number> = {}): void {
    if (!cause) return;
    const now = this.opts.now();
    const ticks = this.ring.snapshot(now, TICK_RING_RETENTION_MS);
    const anomalyId = generateNonce();
    recordCounter(METRIC.dvrAnomalies, 1, { ...this.rollupAttributes(), [ATTR.dvrCause]: cause });
    const common = { ...this.attributes(), [ATTR.dvrAnomalyId]: anomalyId };
    log.info('video.dvr.anomaly', {
      ...common,
      ...extra,
      [ATTR.dvrCause]: cause,
      [ATTR.dvrDelaySec]: this.opts.delaySec(),
      [ATTR.dvrTickCount]: ticks.length,
    });
    for (const tick of ticks) log.debug('video.dvr.tick', { ...common, ...tickAttributes(tick) });
  }
}

function tickAttributes(tick: DvrTickRecord): Record<string, number | boolean> {
  return {
    [ATTR.tickWallTs]: tick.wallTs,
    [ATTR.tickWallGapMs]: tick.wallGapMs,
    [ATTR.tickMediaTime]: tick.mediaTime,
    [ATTR.tickMediaDelta]: tick.mediaDelta,
    [ATTR.tickTargetTime]: tick.targetTime,
    [ATTR.tickFrameTimeServed]: tick.frameTimeServed,
    [ATTR.tickRepeat]: tick.repeat,
    [ATTR.tickCaptureMs]: tick.captureMs,
    [ATTR.tickPresentMs]: tick.presentMs,
    [ATTR.tickStoreCoveredMisses]: tick.storeCoveredMisses,
  };
}
