/**
 * Minimal OTLP/HTTP JSON shapes (opentelemetry-proto rendered as JSON).
 *
 * Gotchas encoded in these types:
 * - int64/fixed64 fields (`*UnixNano`, `intValue`) are decimal STRINGS — nanosecond
 *   epoch timestamps exceed Number.MAX_SAFE_INTEGER.
 * - traceId is 32 lowercase hex chars (16 bytes), spanId is 16 (8 bytes).
 * - Enums (severityNumber, kind, status.code) are integers, not names.
 */

export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** SpanKind: 1 = INTERNAL (the only kind this extension emits). */
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  /** StatusCode: 0 = UNSET, 1 = OK, 2 = ERROR. */
  status: { code: 0 | 1 | 2; message?: string };
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  /** 5 = DEBUG, 9 = INFO, 13 = WARN, 17 = ERROR. */
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
}

/** A consola record forwarded from any extension context to the background exporter. */
export interface ForwardedLogRecord {
  timeMs: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  tag: string;
  context: 'background' | 'content' | 'popup' | 'options';
  message: string;
}

/**
 * runtime.sendMessage envelope for forwarded log records. A plain runtime message
 * (not a comctx RPC method) so the logger never depends on the messaging layer —
 * that import direction would be cyclic (messaging modules use the logger).
 */
export const LOG_RECORD_MESSAGE_TYPE = 'haramblock:log-record';

export interface LogRecordMessage {
  type: typeof LOG_RECORD_MESSAGE_TYPE;
  record: ForwardedLogRecord;
}

export const isLogRecordMessage = (message: unknown): message is LogRecordMessage =>
  typeof message === 'object' && message !== null && (message as { type?: unknown }).type === LOG_RECORD_MESSAGE_TYPE;
