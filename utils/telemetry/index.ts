export { getLogger, setCommonAttributes, type HbLogger } from '@/utils/telemetry/logger';
export { getMeter, getTracer } from '@/utils/telemetry/tracer';
export { ATTR, errorAttributes, requestIdFor } from '@/utils/telemetry/attributes';
export { contextWithSpan, extractTraceparent, injectTraceparent } from '@/utils/telemetry/propagation';
export type { HbContext } from '@/utils/telemetry/config';
export type {
  TelemetryBatch,
  TelemetryExport,
  TelemetryLogRecord,
  TelemetryMetricRecord,
} from '@/utils/telemetry/records';
export { METRIC, metricsEnabled, recordGauge, recordHistogram } from '@/utils/telemetry/metrics';
