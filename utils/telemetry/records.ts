import type { AttributeValue } from '@/utils/telemetry/attributes';
import type { HbContext } from '@/utils/telemetry/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

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

export interface SerializedSpanLink {
  traceId: string;
  spanId: string;
  attributes?: Record<string, AttributeValue>;
}

export interface SerializedSpanEvent {
  name: string;
  timeMs: number;
  attributes?: Record<string, AttributeValue>;
}

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

export type MetricKind = 'gauge' | 'histogram';

export interface TelemetryMetricRecord {
  timeMs: number;
  kind: MetricKind;
  name: string;
  value: number;
  attributes: Record<string, AttributeValue>;
}

export interface TelemetryBatch {
  context: HbContext;
  logs: TelemetryLogRecord[];
  spans: SerializedSpan[];
  metrics?: TelemetryMetricRecord[];
}

export interface TelemetryExport {
  exportedAt: number;
  version: string;
  userAgent: string;
  recordCount: number;
  records: TelemetryLogRecord[];
}
