import type { AttributeValue } from '@/utils/telemetry/attributes';
import type { HbContext } from '@/utils/telemetry/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * One structured log event as buffered and exported, tagged with the extension context and trace it was recorded in.
 */
export interface TelemetryLogRecord {
  timeMs: number;
  level: LogLevel;
  scope: string;
  event: string;
  attributes: Record<string, AttributeValue>;
  context: HbContext;
  traceId?: string;
  spanId?: string;
}

/**
 * A span link in a plain form that survives structured cloning between extension contexts.
 */
export interface SerializedSpanLink {
  traceId: string;
  spanId: string;
  attributes?: Record<string, AttributeValue>;
}

/**
 * A span event in a plain form that survives structured cloning between extension contexts.
 */
export interface SerializedSpanEvent {
  name: string;
  timeMs: number;
  attributes?: Record<string, AttributeValue>;
}

/**
 * A finished span flattened so a non-background context can forward it to the background telemetry pipeline.
 */
export interface SerializedSpan {
  name: string;
  kind: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
  startTimeMs: number;
  endTimeMs: number;
  statusCode: number;
  statusMessage?: string;
  attributes: Record<string, AttributeValue>;
  links: SerializedSpanLink[];
  events: SerializedSpanEvent[];
  scope: string;
  context: HbContext;
}

export type MetricKind = 'gauge' | 'histogram' | 'counter';

/**
 * One metric measurement in a plain form that can be forwarded between extension contexts and replayed into the
 * instruments.
 */
export interface TelemetryMetricRecord {
  timeMs: number;
  kind: MetricKind;
  name: string;
  value: number;
  attributes: Record<string, AttributeValue>;
}

/**
 * Telemetry a non-background context buffered and forwards to the background in one message.
 */
export interface TelemetryBatch {
  context: HbContext;
  logs: TelemetryLogRecord[];
  spans: SerializedSpan[];
  metrics?: TelemetryMetricRecord[];
}

/**
 * The downloadable telemetry dump: buffered log records with the extension version and user agent they came from.
 */
export interface TelemetryExport {
  exportedAt: number;
  version: string;
  userAgent: string;
  recordCount: number;
  records: TelemetryLogRecord[];
}
