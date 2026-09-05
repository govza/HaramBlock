import {
  ANOMALY_LONG_TASK_MS,
  DvrAnomalyDetector,
  DvrTickRing,
  type DvrAnomalyCause,
  type DvrTickRecord,
} from '@/entrypoints/content/video/dvr/probeCore';
import { generateNonce } from '@/utils/nonce';
import { ATTR, getLogger, METRIC, recordGauge, recordHistogram } from '@/utils/telemetry';

import type { SessionFrameStore } from '@/entrypoints/content/video/dvr/frameStoreFactory';

const log = getLogger('dvrProbe');

export const PROBE_WINDOW_MS = 1000;
export const TICK_RING_RETENTION_MS = 5000;
const TICK_RING_CAPACITY = 400;

export type DvrTapKind = 'tap' | 'rvfc';

export type PresentOutcome = 'new' | 'repeat' | 'miss';

export interface PresentedSample {
  mediaTime: number;
  targetTime: number;
  frameTimeServed: number;
  outcome: PresentOutcome;
  presentMs: number;
}

export interface DvrProbeOptions {
  sessionId: string;
  tap: () => DvrTapKind;
  store: SessionFrameStore;
  delaySec: () => number;
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
  private readonly presentSamples = new Float64Array(1024);
  private captureSampleCount = 0;
  private presentSampleCount = 0;
  private windowCaptured = 0;
  private windowPresented = 0;
  private windowRepeats = 0;
  private lastCaptureMs = 0;
  private cachedAttributes: Record<string, string> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unwatchLongTasks: (() => void) | null = null;

  constructor(private readonly opts: DvrProbeOptions) {
    this.detector = new DvrAnomalyDetector(opts.lastAnomalyAt);
    this.unwatchLongTasks = watchLongTasks(this.onLongTask);
    this.timer = setInterval(this.flushWindow, PROBE_WINDOW_MS);
  }

  captured(captureMs: number): void {
    this.windowCaptured++;
    this.lastCaptureMs = captureMs;
    if (this.captureSampleCount < this.captureSamples.length) {
      this.captureSamples[this.captureSampleCount++] = captureMs;
    }
  }

  presented(sample: PresentedSample): void {
    if (!this.opts.isPlaybackActive()) return;
    if (sample.outcome === 'new') this.windowPresented++;
    else if (sample.outcome === 'repeat') this.windowRepeats++;
    const record = this.ring.next();
    record.wallTs = this.opts.now();
    record.mediaTime = sample.mediaTime;
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
    this.windowCaptured = 0;
    this.windowPresented = 0;
    this.windowRepeats = 0;
    const ticks = presented + repeats;
    recordGauge(METRIC.dvrCapturedFps, captured, attributes);
    recordGauge(METRIC.dvrPresentedFps, presented, attributes);
    recordGauge(METRIC.dvrFrameRepeatRatio, ticks === 0 ? 0 : repeats / ticks, attributes);
    recordGauge(METRIC.dvrDelaySec, this.opts.delaySec(), attributes);
    recordGauge(METRIC.dvrRingBytes, this.opts.store.bytes(), attributes);
    recordGauge(METRIC.dvrRingSpanSec, this.opts.store.spanSec(), attributes);
    if (!this.opts.isPlaybackActive()) {
      this.detector.resetWindows();
      return;
    }
    this.dump(this.detector.observeWindow({ captured, presented, nowMs: this.opts.now() }));
  };

  private flushHistograms(attributes: Record<string, string>): void {
    for (let i = 0; i < this.captureSampleCount; i++) {
      const value = this.captureSamples[i];
      if (value !== undefined) recordHistogram(METRIC.dvrCaptureMs, value, attributes);
    }
    for (let i = 0; i < this.presentSampleCount; i++) {
      const value = this.presentSamples[i];
      if (value !== undefined) recordHistogram(METRIC.dvrPresentMs, value, attributes);
    }
    this.captureSampleCount = 0;
    this.presentSampleCount = 0;
  }

  private attributes(): Record<string, string> {
    const store = this.opts.store.kind();
    const tap = this.opts.tap();
    const cached = this.cachedAttributes;
    if (cached && cached[ATTR.dvrStore] === store && cached[ATTR.dvrTap] === tap) return cached;
    this.cachedAttributes = { [ATTR.sessionId]: this.opts.sessionId, [ATTR.dvrStore]: store, [ATTR.dvrTap]: tap };
    return this.cachedAttributes;
  }

  private dump(cause: DvrAnomalyCause | null, extra: Record<string, number> = {}): void {
    if (!cause) return;
    const now = this.opts.now();
    const ticks = this.ring.snapshot(now, TICK_RING_RETENTION_MS);
    const anomalyId = generateNonce();
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
    [ATTR.tickMediaTime]: tick.mediaTime,
    [ATTR.tickTargetTime]: tick.targetTime,
    [ATTR.tickFrameTimeServed]: tick.frameTimeServed,
    [ATTR.tickRepeat]: tick.repeat,
    [ATTR.tickCaptureMs]: tick.captureMs,
    [ATTR.tickPresentMs]: tick.presentMs,
    [ATTR.tickStoreCoveredMisses]: tick.storeCoveredMisses,
  };
}
