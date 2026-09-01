export const ATTR = {
  context: 'hb.context',
  version: 'hb.version',
  backend: 'hb.backend',
  tabId: 'hb.tab.id',
  sessionId: 'hb.session.id',
  frameIndex: 'hb.frame.index',
  reqId: 'hb.req.id',
  hostname: 'hb.hostname',
  mediaKind: 'hb.media.kind',
  parentTraceId: 'hb.parent_trace_id',
  src: 'hb.src',
  status: 'hb.status',
  cacheHit: 'hb.cache_hit',
  detectionsCount: 'hb.detections_count',
  batchSize: 'hb.batch_size',
  modelId: 'hb.model_id',
  overlayType: 'hb.overlay_type',
  transferKind: 'hb.transfer_kind',
  priority: 'hb.priority',
  queueMs: 'hb.timing.queue_ms',
  fetchMs: 'hb.timing.fetch_ms',
  decodeMs: 'hb.timing.decode_ms',
  inferenceMs: 'hb.timing.inference_ms',
  e2eMs: 'hb.timing.e2e_ms',
  errorType: 'error.type',
  errorMessage: 'error.message',
  errorStack: 'error.stack',
} as const;

export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
export type Attributes = Record<string, AttributeValue | undefined>;
export type LooseAttributes = Record<string, unknown>;

/**
 * FNV-1a over the media URL, so the same image always maps to the same short id in every context.
 */
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

/**
 * Coerce arbitrary call-site attributes to the OTel attribute value space: errors expand to
 * error.* keys, plain objects become JSON, undefined is dropped.
 */
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
