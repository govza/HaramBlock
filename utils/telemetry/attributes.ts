export const ATTR = {
  context: 'hb.context',
  version: 'hb.version',
  backend: 'hb.backend',
  tabId: 'hb.tab.id',
  sessionId: 'hb.session.id',
  frameIndex: 'hb.frame.index',
  reqId: 'hb.request.id',
  hostname: 'hb.hostname',
  mediaKind: 'hb.media.kind',
  sessionTraceId: 'hb.session.trace_id',
  src: 'hb.media.src',
  status: 'hb.status',
  cacheHit: 'hb.cache.hit',
  detectionsCount: 'hb.detections.count',
  batchSize: 'hb.batch.size',
  modelId: 'hb.model.id',
  overlayType: 'hb.overlay.type',
  transferKind: 'hb.transfer.kind',
  priority: 'hb.priority',
  queueMs: 'hb.timing.queue_ms',
  fetchMs: 'hb.timing.fetch_ms',
  decodeMs: 'hb.timing.decode_ms',
  inferenceMs: 'hb.timing.inference_ms',
  e2eMs: 'hb.timing.e2e_ms',
  timestampSec: 'hb.media.timestamp_sec',
  dvrStore: 'hb.dvr.store',
  dvrTap: 'hb.dvr.tap',
  dvrDelaySec: 'hb.dvr.delay_sec',
  dvrCovered: 'hb.dvr.covered',
  dvrReason: 'hb.dvr.reason',
  dvrCause: 'hb.dvr.cause',
  dvrFromSec: 'hb.dvr.from_sec',
  dvrToSec: 'hb.dvr.to_sec',
  dvrAnomalyId: 'hb.dvr.anomaly.id',
  dvrTickCount: 'hb.dvr.tick.count',
  dvrCoverageAheadSec: 'hb.dvr.coverage_ahead_sec',
  dvrAnomalyLongTaskMs: 'hb.dvr.anomaly.long_task_ms',
  tickMediaTime: 'hb.dvr.tick.media_time',
  tickTargetTime: 'hb.dvr.tick.target_time',
  tickFrameTimeServed: 'hb.dvr.tick.frame_time_served',
  tickOutcome: 'hb.dvr.tick.outcome',
  tickPinned: 'hb.dvr.tick.pinned',
  tickRingSpanSec: 'hb.dvr.tick.ring_span_sec',
  tickCaptureMs: 'hb.dvr.tick.capture_ms',
  tickPresentMs: 'hb.dvr.tick.present_ms',
  tickPresentBaseMs: 'hb.dvr.tick.present_base_ms',
  tickPresentMaskMs: 'hb.dvr.tick.present_mask_ms',
  tickPresentSource: 'hb.dvr.tick.present_source',
  tickStoreLookahead: 'hb.dvr.tick.store_lookahead',
  tickStoreCoveredMisses: 'hb.dvr.tick.store_covered_misses',
  tickWallTs: 'hb.dvr.tick.wall_ts',
  tickMediaDelta: 'hb.dvr.tick.media_delta',
  tickWallGapMs: 'hb.dvr.tick.wall_gap_ms',
  dvrTapReason: 'hb.dvr.tap_reason',
  dvrStoreReason: 'hb.dvr.store_reason',
  dvrBackstepFrames: 'hb.dvr.backstep_frames',
  dvrSpanLostSec: 'hb.dvr.span_lost_sec',
  dvrCaptureWidth: 'hb.dvr.capture.width',
  dvrCaptureHeight: 'hb.dvr.capture.height',
  mediaNativeWidth: 'hb.media.native_width',
  mediaNativeHeight: 'hb.media.native_height',
  mediaDisplayWidth: 'hb.media.display_width',
  browser: 'hb.browser',
  sessionFrom: 'hb.session.from',
  sessionTo: 'hb.session.to',
  sessionEvent: 'hb.session.event',
  sessionDvr: 'hb.session.dvr',
  sessionAudioRoute: 'hb.session.audio_route',
  audioRouteResult: 'hb.audio.route.result',
  audioRoute: 'hb.audio.route',
  dvrFrom: 'hb.dvr.from',
  dvrTo: 'hb.dvr.to',
  captureStage: 'hb.capture.stage',
  capturePermanent: 'hb.capture.permanent',
  budgetMaxWidth: 'hb.budget.max_width',
  budgetCaptureIntervalSec: 'hb.budget.capture_interval_sec',
  budgetHorizonScale: 'hb.budget.horizon_scale',
  budgetProjectedBytes: 'hb.budget.projected_bytes',
  budgetGlobalBytes: 'hb.budget.global_bytes',
  budgetSessions: 'hb.budget.sessions',
  errorType: 'error.type',
  errorMessage: 'error.message',
  errorStack: 'error.stack',
} as const;

export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
export type Attributes = Record<string, AttributeValue | undefined>;
export type LooseAttributes = Record<string, unknown>;

export function requestIdFor(src: string): string {
  let hash = 2166136261;
  for (let i = 0; i < src.length; i++) {
    hash ^= src.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function errorAttributes(error: unknown): Attributes {
  if (error instanceof Error) {
    return { [ATTR.errorType]: error.name, [ATTR.errorMessage]: error.message, [ATTR.errorStack]: error.stack };
  }
  if (error === undefined || error === null) return {};
  return { [ATTR.errorType]: typeof error, [ATTR.errorMessage]: stringify(error) };
}

const stringify = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return Object.prototype.toString.call(value);
  }
};

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

export function sanitizeAttributes(input: LooseAttributes | undefined): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {};
  if (!input) return result;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Error) {
      Object.assign(result, sanitizeAttributes(errorAttributes(value)));
      continue;
    }
    if (isPrimitive(value)) {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every(isPrimitive)) {
      result[key] = value as AttributeValue;
      continue;
    }
    result[key] = stringify(value);
  }
  return result;
}
