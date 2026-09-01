import { FORWARD_BATCH_DELAY_MS, type HbContext } from '@/utils/telemetry/config';

import type { SerializedSpan, TelemetryBatch, TelemetryLogRecord } from '@/utils/telemetry/records';

export type SendBatch = (batch: TelemetryBatch) => Promise<void>;

export class TelemetryForwarder {
  private logs: TelemetryLogRecord[] = [];
  private spans: SerializedSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly hbContext: HbContext,
    private readonly send: SendBatch,
    private readonly delayMs = FORWARD_BATCH_DELAY_MS,
  ) {}

  pushLog = (record: TelemetryLogRecord): void => {
    this.logs.push(record);
    this.schedule();
  };

  pushSpans(spans: SerializedSpan[]): void {
    if (spans.length === 0) return;
    this.spans.push(...spans);
    this.schedule();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.logs.length === 0 && this.spans.length === 0) return;
    const batch: TelemetryBatch = { context: this.hbContext, logs: this.logs, spans: this.spans };
    this.logs = [];
    this.spans = [];
    try {
      await this.send(batch);
    } catch {
      return;
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }
}
