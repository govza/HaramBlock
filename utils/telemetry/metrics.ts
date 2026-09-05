import { sanitizeAttributes, type LooseAttributes } from '@/utils/telemetry/attributes';

import type { MetricKind, TelemetryMetricRecord } from '@/utils/telemetry/records';

export const METRIC = {
  dvrCapturedFps: 'hb.dvr.captured_fps',
  dvrPresentedFps: 'hb.dvr.presented_fps',
  dvrFrameRepeatRatio: 'hb.dvr.frame_repeat_ratio',
  dvrDelaySec: 'hb.dvr.delay_sec',
  dvrRingBytes: 'hb.dvr.ring_bytes',
  dvrRingSpanSec: 'hb.dvr.ring_span_sec',
  inferenceQueueDepth: 'hb.inference.queue_depth',
  dvrCaptureMs: 'hb.dvr.capture_ms',
  dvrPresentMs: 'hb.dvr.present_ms',
  inferenceRoundtripMs: 'hb.inference.roundtrip_ms',
  mainThreadLongTaskMs: 'hb.main_thread.long_task_ms',
} as const;

export type MetricName = (typeof METRIC)[keyof typeof METRIC];

export type MetricSink = (record: TelemetryMetricRecord) => void;

const sinks = new Set<MetricSink>();

export function registerMetricSink(sink: MetricSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function metricsEnabled(): boolean {
  return sinks.size > 0;
}

function emit(kind: MetricKind, name: MetricName, value: number, attributes?: LooseAttributes): void {
  if (sinks.size === 0 || !Number.isFinite(value)) return;
  const record: TelemetryMetricRecord = {
    timeMs: Date.now(),
    kind,
    name,
    value,
    attributes: sanitizeAttributes(attributes),
  };
  for (const sink of sinks) {
    try {
      sink(record);
    } catch {
      continue;
    }
  }
}

export function recordGauge(name: MetricName, value: number, attributes?: LooseAttributes): void {
  emit('gauge', name, value, attributes);
}

export function recordHistogram(name: MetricName, value: number, attributes?: LooseAttributes): void {
  emit('histogram', name, value, attributes);
}
