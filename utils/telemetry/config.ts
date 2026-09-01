declare const __HB_TELEMETRY_ENABLED__: boolean;
declare const __HB_OTEL_ENDPOINT__: string;

export type HbContext = 'content' | 'background' | 'popup' | 'options';

export const TELEMETRY_ENABLED: boolean = __HB_TELEMETRY_ENABLED__;
export const OTEL_ENDPOINT: string = __HB_OTEL_ENDPOINT__;

export const FORWARD_BATCH_DELAY_MS = 1000;
export const EXPORT_BATCH_DELAY_MS = 1000;
export const METRIC_EXPORT_INTERVAL_MS = 1000;
export const IDLE_FLUSH_DELAY_MS = 5000;
export const RING_CAPACITY = 500;
