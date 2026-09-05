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
  inferenceRunDurationMs: 'hb.inference.run.duration',
  inferenceRequests: 'hb.inference.requests',
  dvrPlaybackActive: 'hb.dvr.playback_active',
  dvrActiveWindows: 'hb.dvr.active_windows',
  dvrHealthyWindows: 'hb.dvr.healthy_windows',
  dvrFreezeWindows: 'hb.dvr.freeze_windows',
  dvrFramesDropped: 'hb.dvr.frames_dropped',
  dvrVerdictMarginSec: 'hb.dvr.verdict_margin_sec',
  dvrWarmupMs: 'hb.dvr.warmup_ms',
  dvrRunsStarted: 'hb.dvr.runs_started',
  dvrRunsStopped: 'hb.dvr.runs_stopped',
  dvrAnomalies: 'hb.dvr.anomalies',
  audioDriftMs: 'hb.audio.drift_ms',
  audioUnderruns: 'hb.audio.underruns',
  audioUnavailableWindows: 'hb.audio.unavailable_windows',
  audioRouteWindows: 'hb.audio.route_windows',
  dvrTickGapMs: 'hb.dvr.tick_gap_ms',
  dvrSourceFps: 'hb.dvr.source_fps',
  dvrTicksDeduped: 'hb.dvr.ticks_deduped',
  dvrSourceFramesSkipped: 'hb.dvr.source_frames_skipped',
  dvrTicksLate: 'hb.dvr.ticks_late',
  dvrCaptureDrawMs: 'hb.dvr.capture_draw_ms',
  dvrCaptureTransferMs: 'hb.dvr.capture_transfer_ms',
  dvrCaptureWidth: 'hb.dvr.capture_width',
  dvrCaptureHeight: 'hb.dvr.capture_height',
  dvrNativeWidth: 'hb.dvr.native_width',
  dvrNativeHeight: 'hb.dvr.native_height',
  dvrRingFlushes: 'hb.dvr.ring_flushes',
  dvrSourceBacksteps: 'hb.dvr.source_backsteps',
  dvrPinnedWindows: 'hb.dvr.pinned_windows',
  dvrMainThreadMs: 'hb.dvr.main_thread_ms',
  mainThreadLoopLagMs: 'hb.main_thread.loop_lag_ms',
  samplerEncodeMs: 'hb.sampler.encode_ms',
  samplerFramesSent: 'hb.sampler.frames_sent',
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
