export {
  initTelemetry,
  isTelemetryEnabled,
  telemetryOnBackgroundEvent,
  telemetryOnMergedEvent,
  telemetryOnContentOnlyEvent,
  telemetryOnLogRecord,
} from '@/utils/telemetry/telemetry';
export { OtlpExporter } from '@/utils/telemetry/otlpExporter';
export type { ForwardedLogRecord } from '@/utils/telemetry/types';
