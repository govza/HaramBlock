import { sanitizeAttributes, type LooseAttributes } from '@/utils/telemetry/attributes';

import type { MetricKind, TelemetryMetricRecord } from '@/utils/telemetry/records';

export const METRIC = {
  inferenceQueueDepth: 'hb.inference.queue_depth',
  inferenceRoundtripMs: 'hb.inference.roundtrip_ms',
  inferenceRunDurationMs: 'hb.inference.run.duration',
  inferenceRequests: 'hb.inference.requests',
  samplerEncodeMs: 'hb.sampler.encode_ms',
  samplerFramesSent: 'hb.sampler.frames_sent',
  videoTapSessions: 'hb.video.tap.sessions',
  videoCoverageAheadSec: 'hb.video.coverage_ahead_sec',
  videoUncoveredPlayingMs: 'hb.video.uncovered_playing_ms',
  videoLiveMaskingMs: 'hb.video.live_masking_ms',
  lookaheadSamples: 'hb.lookahead.samples',
  lookaheadFailures: 'hb.lookahead.failures',
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

export function recordCounter(name: MetricName, value: number, attributes?: LooseAttributes): void {
  if (value <= 0) return;
  emit('counter', name, value, attributes);
}
