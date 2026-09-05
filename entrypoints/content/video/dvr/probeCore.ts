export type DvrAnomalyCause = 'fps_drop' | 'long_task' | 'underrun' | 'store_stall';

export const ANOMALY_FPS_RATIO = 0.75;
export const ANOMALY_LONG_TASK_MS = 100;
export const ANOMALY_RATE_LIMIT_MS = 10_000;
export const ANOMALY_FPS_WINDOWS = 2;

export interface FpsWindow {
  captured: number;
  presented: number;
  nowMs: number;
}

export class DvrAnomalyDetector {
  private lastDumpAt = Number.NEGATIVE_INFINITY;
  private droppedWindows = 0;

  observeWindow(window: FpsWindow): DvrAnomalyCause | null {
    if (window.captured <= 0) {
      this.droppedWindows = 0;
      return null;
    }
    const dropped = window.presented < window.captured * ANOMALY_FPS_RATIO;
    this.droppedWindows = dropped ? this.droppedWindows + 1 : 0;
    if (this.droppedWindows < ANOMALY_FPS_WINDOWS) return null;
    this.droppedWindows = 0;
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

export interface DvrTickRecord {
  wallTs: number;
  mediaTime: number;
  targetTime: number;
  frameTimeServed: number;
  repeat: boolean;
  captureMs: number;
  presentMs: number;
  storeCoveredMisses: number;
}

const emptyRecord = (): DvrTickRecord => ({
  wallTs: 0,
  mediaTime: 0,
  targetTime: 0,
  frameTimeServed: 0,
  repeat: false,
  captureMs: 0,
  presentMs: 0,
  storeCoveredMisses: 0,
});

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
