export type DvrAnomalyCause = 'fps_drop' | 'long_task' | 'underrun' | 'store_stall';

export const ANOMALY_FPS_RATIO = 0.75;
export const ANOMALY_LONG_TASK_MS = 100;
export const ANOMALY_RATE_LIMIT_MS = 10_000;
export const ANOMALY_FPS_WINDOWS = 2;
export const HEALTHY_PRESENTED_RATIO = 0.9;
export const HEALTHY_LONG_TASK_MS = ANOMALY_LONG_TASK_MS;

export interface HealthWindow {
  captured: number;
  presented: number;
  repeats: number;
  longestTaskMs: number;
  audioUnderruns: number;
}

export function droppedFrames(window: HealthWindow): number {
  return Math.max(0, window.captured - window.presented - window.repeats);
}

export function isFrozen(window: HealthWindow): boolean {
  return window.presented === 0;
}

export function isHealthy(window: HealthWindow): boolean {
  if (isFrozen(window)) return false;
  if (window.longestTaskMs > HEALTHY_LONG_TASK_MS) return false;
  if (window.audioUnderruns > 0) return false;
  return window.presented + window.repeats >= window.captured * HEALTHY_PRESENTED_RATIO;
}

export interface FpsWindow {
  captured: number;
  presented: number;
  nowMs: number;
}

export class DvrAnomalyDetector {
  constructor(public lastDumpAt = Number.NEGATIVE_INFINITY) {}

  resetWindows(): void {
    this.recentWindows.length = 0;
  }
  private readonly recentWindows: FpsWindow[] = [];

  observeWindow(window: FpsWindow): DvrAnomalyCause | null {
    this.recentWindows.push(window);
    if (this.recentWindows.length < ANOMALY_FPS_WINDOWS) return null;
    if (this.recentWindows.length > ANOMALY_FPS_WINDOWS) this.recentWindows.shift();
    let captured = 0;
    let presented = 0;
    for (const recent of this.recentWindows) {
      captured += recent.captured;
      presented += recent.presented;
    }
    if (captured <= 0 || presented >= captured * ANOMALY_FPS_RATIO) return null;
    this.recentWindows.length = 0;
    return this.signal('fps_drop', window.nowMs);
  }

  observeLongTask(durationMs: number, nowMs: number): DvrAnomalyCause | null {
    if (durationMs <= ANOMALY_LONG_TASK_MS) return null;
    return this.signal('long_task', nowMs);
  }

  signal(cause: DvrAnomalyCause, nowMs: number): DvrAnomalyCause | null {
    if (nowMs - this.lastDumpAt < ANOMALY_RATE_LIMIT_MS) return null;
    this.lastDumpAt = nowMs;
    return cause;
  }
}

export type PresentOutcome = 'new' | 'repeat' | 'miss';

export interface DvrTickRecord {
  wallTs: number;
  wallGapMs: number;
  mediaTime: number;
  mediaDelta: number;
  targetTime: number;
  frameTimeServed: number;
  outcome: PresentOutcome;
  pinned: boolean;
  ringSpanSec: number;
  captureMs: number;
  presentMs: number;
  storeCoveredMisses: number;
}

const emptyRecord = (): DvrTickRecord => ({
  wallTs: 0,
  wallGapMs: 0,
  mediaTime: 0,
  mediaDelta: 0,
  targetTime: 0,
  frameTimeServed: 0,
  outcome: 'miss',
  pinned: false,
  ringSpanSec: 0,
  captureMs: 0,
  presentMs: 0,
  storeCoveredMisses: 0,
});

export const SOURCE_SKIP_RATIO = 1.5;
export const LATE_TICK_RATIO = 1.5;
const MIN_FRAME_INTERVAL_SEC = 1 / 120;
export const BACKSTEP_SEEK_FRAMES = 12;

export type SourceDeliveryKind = 'new' | 'duplicate' | 'seek';
export type BackstepBucket = '1' | '2' | '3+' | 'seek';
export const BACKSTEP_BUCKETS: readonly BackstepBucket[] = ['1', '2', '3+', 'seek'];

export interface SourceDelivery {
  kind: SourceDeliveryKind;
  mediaDelta: number;
  wallGapMs: number;
  framesSkipped: number;
  late: boolean;
  backstep: BackstepBucket | null;
}

export function backstepBucket(mediaDelta: number, frameIntervalSec: number): BackstepBucket {
  if (!Number.isFinite(frameIntervalSec)) return 'seek';
  const frames = Math.round(-mediaDelta / frameIntervalSec);
  if (frames <= 1) return '1';
  if (frames === 2) return '2';
  if (frames <= BACKSTEP_SEEK_FRAMES) return '3+';
  return 'seek';
}

export class SourceClock {
  private lastMediaTime = Number.NEGATIVE_INFINITY;
  private lastWallMs = Number.NEGATIVE_INFINITY;
  private frameIntervalSec = Number.POSITIVE_INFINITY;

  observe(mediaTime: number, wallMs: number): SourceDelivery {
    const first = !Number.isFinite(this.lastMediaTime);
    const mediaDelta = first ? 0 : mediaTime - this.lastMediaTime;
    const wallGapMs = Number.isFinite(this.lastWallMs) ? wallMs - this.lastWallMs : 0;
    this.lastWallMs = wallMs;
    if (!first && mediaDelta === 0) {
      return { kind: 'duplicate', mediaDelta, wallGapMs, framesSkipped: 0, late: false, backstep: null };
    }
    this.lastMediaTime = mediaTime;
    if (first) return { kind: 'new', mediaDelta, wallGapMs, framesSkipped: 0, late: false, backstep: null };
    if (mediaDelta < 0) {
      const backstep = backstepBucket(mediaDelta, this.frameIntervalSec);
      this.frameIntervalSec = Number.POSITIVE_INFINITY;
      return { kind: 'seek', mediaDelta, wallGapMs, framesSkipped: 0, late: false, backstep };
    }
    if (mediaDelta < this.frameIntervalSec) this.frameIntervalSec = Math.max(mediaDelta, MIN_FRAME_INTERVAL_SEC);
    const intervalSec = this.frameIntervalSec;
    const framesSkipped =
      mediaDelta > intervalSec * SOURCE_SKIP_RATIO ? Math.max(0, Math.round(mediaDelta / intervalSec) - 1) : 0;
    const late = wallGapMs > intervalSec * 1000 * LATE_TICK_RATIO;
    return { kind: 'new', mediaDelta, wallGapMs, framesSkipped, late, backstep: null };
  }

  estimatedFps(): number {
    return Number.isFinite(this.frameIntervalSec) ? 1 / this.frameIntervalSec : 0;
  }
}

export class DvrTickRing {
  private readonly records: DvrTickRecord[];
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.records = Array.from({ length: capacity }, emptyRecord);
  }

  next(): DvrTickRecord {
    const record = this.records[this.head] as DvrTickRecord;
    this.head = (this.head + 1) % this.records.length;
    if (this.count < this.records.length) this.count++;
    return record;
  }

  snapshot(nowMs?: number, retentionMs?: number): DvrTickRecord[] {
    const oldestAllowed =
      nowMs === undefined || retentionMs === undefined ? Number.NEGATIVE_INFINITY : nowMs - retentionMs;
    const result: DvrTickRecord[] = [];
    const start = (this.head - this.count + this.records.length) % this.records.length;
    for (let i = 0; i < this.count; i++) {
      const record = this.records[(start + i) % this.records.length] as DvrTickRecord;
      if (record.wallTs >= oldestAllowed) result.push(record);
    }
    return result;
  }
}
