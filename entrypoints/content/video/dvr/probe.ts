import {
  ANOMALY_LONG_TASK_MS,
  DvrAnomalyDetector,
  DvrTickRing,
  type DvrAnomalyCause,
  type DvrTickRecord,
} from '@/entrypoints/content/video/dvr/probeCore';
import { generateNonce } from '@/utils/nonce';
import { ATTR, getLogger, METRIC, recordGauge, recordHistogram } from '@/utils/telemetry';

import type { DvrStoreKind } from '@/entrypoints/content/video/dvr/frameStore';

const log = getLogger('dvrProbe');

export const PROBE_WINDOW_MS = 1000;
export const TICK_RING_RETENTION_MS = 5000;
const TICK_RING_CAPACITY = 400;

export type DvrTapKind = 'tap' | 'rvfc';

export interface PresentedSample {
  mediaTime: number;
  targetTime: number;
  frameTimeServed: number;
  repeat: boolean;
  presentMs: number;
}

export interface DvrProbeOptions {
  sessionId: string;
  tap: DvrTapKind;
  storeKind: () => DvrStoreKind;
  storeBytes: () => number;
  storeSpanSec: () => number;
  storeCoveredMisses: () => number;
  delaySec: () => number;
  now: () => number;
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
  private readonly detector = new DvrAnomalyDetector();
  private windowCaptured = 0;
  private windowPresented = 0;
  private windowRepeats = 0;
  private lastCaptureMs = 0;
  private presenting = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unwatchLongTasks: (() => void) | null = null;

  constructor(private readonly opts: DvrProbeOptions) {
    this.timer = setInterval(this.flushWindow, PROBE_WINDOW_MS);
  }

  captured(captureMs: number): void {
    this.windowCaptured++;
    this.lastCaptureMs = captureMs;
    recordHistogram(METRIC.dvrCaptureMs, captureMs, this.attributes());
  }

  presented(sample: PresentedSample): void {
    if (!this.presenting) {
      this.presenting = true;
      this.unwatchLongTasks = watchLongTasks(this.onLongTask);
    }
    if (!sample.repeat) this.windowPresented++;
    else this.windowRepeats++;
    const record = this.ring.next();
    record.wallTs = this.opts.now();
    record.mediaTime = sample.mediaTime;
    record.targetTime = sample.targetTime;
    record.frameTimeServed = sample.frameTimeServed;
    record.repeat = sample.repeat;
    record.captureMs = this.lastCaptureMs;
    record.presentMs = sample.presentMs;
    record.storeCoveredMisses = this.opts.storeCoveredMisses();
    recordHistogram(METRIC.dvrPresentMs, sample.presentMs, this.attributes());
  }

  signal(cause: Extract<DvrAnomalyCause, 'underrun' | 'store_stall'>): void {
    this.dump(this.detector.signal(cause, this.opts.now()));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unwatchLongTasks?.();
    this.unwatchLongTasks = null;
  }

  private readonly onLongTask = (durationMs: number): void => {
    if (!this.presenting) return;
    recordHistogram(METRIC.mainThreadLongTaskMs, durationMs, this.attributes());
    if (durationMs <= ANOMALY_LONG_TASK_MS) return;
    this.dump(this.detector.observeLongTask(durationMs, this.opts.now()), { [ATTR.longTaskMs]: durationMs });
  };

  private readonly flushWindow = (): void => {
    const attributes = this.attributes();
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
    recordGauge(METRIC.dvrRingBytes, this.opts.storeBytes(), attributes);
    recordGauge(METRIC.dvrRingSpanSec, this.opts.storeSpanSec(), attributes);
    if (!this.presenting) return;
    this.dump(this.detector.observeWindow({ captured, presented, nowMs: this.opts.now() }));
  };

  private attributes(): Record<string, string> {
    return {
      [ATTR.sessionId]: this.opts.sessionId,
      [ATTR.dvrStore]: this.opts.storeKind(),
      [ATTR.dvrTap]: this.opts.tap,
    };
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
