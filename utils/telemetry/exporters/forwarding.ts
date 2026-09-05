import {
  FORWARD_BATCH_DELAY_MS,
  FORWARD_MAX_BUFFERED,
  FORWARD_RETRY_DELAY_MS,
  type HbContext,
} from '@/utils/telemetry/config';

import type {
  SerializedSpan,
  TelemetryBatch,
  TelemetryLogRecord,
  TelemetryMetricRecord,
} from '@/utils/telemetry/records';

export type SendBatch = (batch: TelemetryBatch) => Promise<void>;

export class TelemetryForwarder {
  private logs: TelemetryLogRecord[] = [];
  private spans: SerializedSpan[] = [];
  private metrics: TelemetryMetricRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly hbContext: HbContext,
    private readonly send: SendBatch,
    private readonly delayMs = FORWARD_BATCH_DELAY_MS,
    private readonly retryDelayMs = FORWARD_RETRY_DELAY_MS,
    private readonly maxBuffered = FORWARD_MAX_BUFFERED,
  ) {}

  pushLog = (record: TelemetryLogRecord): void => {
    this.logs = this.bounded([...this.logs, record]);
    this.schedule(this.delayMs);
  };

  pushSpans(spans: SerializedSpan[]): void {
    if (spans.length === 0) return;
    this.spans = this.bounded([...this.spans, ...spans]);
    this.schedule(this.delayMs);
  }

  pushMetric = (record: TelemetryMetricRecord): void => {
    this.metrics.push(record);
    if (this.metrics.length > this.maxBuffered) this.metrics.splice(0, this.metrics.length - this.maxBuffered);
    this.schedule(this.delayMs);
  };

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.logs.length === 0 && this.spans.length === 0 && this.metrics.length === 0) return;
    const batch: TelemetryBatch = {
      context: this.hbContext,
      logs: this.logs,
      spans: this.spans,
      metrics: this.metrics,
    };
    this.logs = [];
    this.spans = [];
    this.metrics = [];
    try {
      await this.send(batch);
    } catch {
      this.requeue(batch);
      this.schedule(this.retryDelayMs);
    }
  }

  private requeue(batch: TelemetryBatch): void {
    this.logs = this.bounded([...batch.logs, ...this.logs]);
    this.spans = this.bounded([...batch.spans, ...this.spans]);
    this.metrics = this.bounded([...(batch.metrics ?? []), ...this.metrics]);
  }

  private bounded<T>(items: T[]): T[] {
    return items.length > this.maxBuffered ? items.slice(items.length - this.maxBuffered) : items;
  }

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }
}
