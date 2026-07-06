import type { OtlpKeyValue, OtlpLogRecord, OtlpSpan } from '@/utils/telemetry/types';

export interface OtlpExporterOptions {
  /** OTLP/HTTP base endpoint; /v1/traces and /v1/logs are appended. */
  endpoint: string;
  /** Resource attributes stamped on every export (service.name etc.). */
  resourceAttributes: OtlpKeyValue[];
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  fetchFn?: typeof fetch;
}

const WARN_INTERVAL_MS = 30_000;
const SCOPE = { name: 'haramblock' };

/**
 * Zero-dependency batching OTLP/HTTP JSON exporter.
 *
 * Failure policy: dev-only tooling, so failed batches are dropped (no retry/backoff)
 * with a rate-limited raw console.warn. Errors must never route through the logger —
 * the logger forwards records back into this exporter.
 */
export class OtlpExporter {
  private spans: OtlpSpan[] = [];
  private logs: OtlpLogRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWarnAt = 0;
  private disposed = false;

  private readonly flushIntervalMs: number;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OtlpExporterOptions) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.maxBatch = opts.maxBatch ?? 20;
    this.maxQueue = opts.maxQueue ?? 200;
    // bind: calling an unbound fetch through this.fetchFn sets `this` to the exporter
    // instance, which throws "Illegal invocation" in worker/window contexts
    this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  }

  pushSpans(spans: OtlpSpan[]): void {
    if (this.disposed || spans.length === 0) return;
    this.spans.push(...spans);
    this.trim(this.spans);
    this.scheduleFlush();
  }

  pushLog(record: OtlpLogRecord): void {
    if (this.disposed) return;
    this.logs.push(record);
    this.trim(this.logs);
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const spans = this.spans.splice(0);
    const logs = this.logs.splice(0);

    await Promise.all([
      spans.length > 0
        ? this.post('/v1/traces', {
            resourceSpans: [
              { resource: { attributes: this.opts.resourceAttributes }, scopeSpans: [{ scope: SCOPE, spans }] },
            ],
          })
        : undefined,
      logs.length > 0
        ? this.post('/v1/logs', {
            resourceLogs: [
              {
                resource: { attributes: this.opts.resourceAttributes },
                scopeLogs: [{ scope: SCOPE, logRecords: logs }],
              },
            ],
          })
        : undefined,
    ]);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.spans = [];
    this.logs = [];
  }

  private scheduleFlush(): void {
    if (this.spans.length >= this.maxBatch || this.logs.length >= this.maxBatch) {
      void this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
    }
  }

  private trim(queue: unknown[]): void {
    while (queue.length > this.maxQueue) {
      queue.shift();
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      const response = await this.fetchFn(`${this.opts.endpoint}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        this.warn(`OTLP export to ${path} failed: HTTP ${response.status}`);
      }
    } catch (error) {
      this.warn(`OTLP export to ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    console.warn(`[otlp] ${message} (batch dropped; is the collector running on ${this.opts.endpoint}?)`);
  }
}
