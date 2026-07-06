import { msToNano, newSpanId, toAttributes, SEVERITY } from '@/utils/telemetry/otlpJson';

import type { WideEvent } from '@/utils/logging/types';
import type { OtlpKeyValue, OtlpLogRecord, OtlpSpan } from '@/utils/telemetry/types';

export interface TraceExport {
  spans: OtlpSpan[];
  logRecord: OtlpLogRecord;
}

/** Every defined WideEvent field as a flat snake_case attribute set — this IS the wide event. */
const flattenEvent = (event: WideEvent): OtlpKeyValue[] =>
  toAttributes({
    req_id: event.reqId,
    src: event.src,
    hostname: event.hostname,
    context: event.context,
    status: event.status,
    reason: event.reason,
    stage: event.stage,
    source: event.source,
    total_ms: event.totalMs,
    queue_ms: event.queueMs,
    fetch_ms: event.fetchMs,
    decode_ms: event.decodeMs,
    inference_ms: event.inferenceMs,
    e2e_ms: event.e2eMs,
    send_ms: event.sendMs,
    wait_ms: event.waitMs,
    style_ms: event.styleMs,
    detections_count: event.detectionsCount,
    batch_size: event.batchSize,
    cache_hit: event.cacheHit,
    overlay_type: event.overlayType,
    backend: event.backend,
    model_id: event.modelId,
    'error.message': event.error?.message,
    'error.type': event.error?.type,
    version: event.version,
  });

interface SpanBuilder {
  traceId: string;
  spans: OtlpSpan[];
}

const addSpan = (
  b: SpanBuilder,
  name: string,
  startMs: number,
  endMs: number,
  parentSpanId: string | undefined,
  attributes: OtlpKeyValue[] = [],
  status: OtlpSpan['status'] = { code: 1 },
): OtlpSpan => {
  const span: OtlpSpan = {
    traceId: b.traceId,
    spanId: newSpanId(),
    parentSpanId,
    name,
    kind: 1,
    startTimeUnixNano: msToNano(startMs),
    endTimeUnixNano: msToNano(Math.max(endMs, startMs)),
    attributes,
    status,
  };
  b.spans.push(span);
  return span;
};

/**
 * Adds the sequential background phase spans (queue → fetch → decode → inference)
 * under `parent`, starting at `startMs`. Phases without a duration are omitted
 * (skipped/cached/error events).
 */
const addBackgroundPhases = (b: SpanBuilder, event: WideEvent, startMs: number, parent: OtlpSpan): void => {
  let cursor = startMs;
  const phases: Array<[string, number | undefined]> = [
    ['background.queue', event.queueMs],
    ['background.fetch', event.fetchMs],
    ['background.decode', event.decodeMs],
    ['background.inference', event.inferenceMs],
  ];
  for (const [name, duration] of phases) {
    if (duration === undefined) continue;
    addSpan(b, name, cursor, cursor + duration, parent.spanId);
    cursor += duration;
  }
};

/** Adds content phase spans (send → wait → style) under `root`; returns the wait span if created. */
const addContentPhases = (b: SpanBuilder, event: WideEvent, startMs: number, root: OtlpSpan): OtlpSpan | undefined => {
  let cursor = startMs;
  let waitSpan: OtlpSpan | undefined;
  if (event.sendMs !== undefined) {
    addSpan(b, 'content.send', cursor, cursor + event.sendMs, root.spanId);
    cursor += event.sendMs;
  }
  if (event.waitMs !== undefined) {
    waitSpan = addSpan(b, 'content.wait', cursor, cursor + event.waitMs, root.spanId);
    cursor += event.waitMs;
  }
  if (event.styleMs !== undefined) {
    addSpan(b, 'content.style', cursor, cursor + event.styleMs, root.spanId);
  }
  return waitSpan;
};

const rootStatus = (event: WideEvent): OtlpSpan['status'] =>
  event.status === 'error' ? { code: 2, message: event.error?.message ?? event.reason ?? 'error' } : { code: 1 };

/**
 * Maps one wide event to an OTLP trace (root + phase spans) plus one wide log record
 * (canonical log line: all fields as attributes, correlated to the trace).
 *
 * Three shapes:
 * - merged (background event carrying contentTimestamp/contentTotalMs): root spans the
 *   content window; background.process nests under content.wait.
 * - background-only (cached, video/GIF frames, merge timeout): root spans the
 *   background window with its phase children.
 * - content-only (no matching background event): root + send/wait/style.
 *
 * Durations come from performance.now deltas but anchors from Date.now in two JS
 * contexts, so the background span can poke slightly outside content.wait — accepted,
 * not clamped.
 */
export const wideEventToOtlp = (event: WideEvent, traceId: string): TraceExport => {
  const b: SpanBuilder = { traceId, spans: [] };
  const attributes = flattenEvent(event);
  let root: OtlpSpan;

  if (event.contentTimestamp !== undefined && event.contentTotalMs !== undefined) {
    // Merged event: content window is the trace envelope
    const contentEnd = event.contentTimestamp;
    const contentStart = contentEnd - event.contentTotalMs;
    root = addSpan(b, 'image.process', contentStart, contentEnd, undefined, attributes, rootStatus(event));
    const waitSpan = addContentPhases(b, event, contentStart, root);

    const bgEnd = event.timestamp;
    const bgStart = bgEnd - event.totalMs;
    const bgParent = waitSpan ?? root;
    const bgSpan = addSpan(b, 'background.process', bgStart, bgEnd, bgParent.spanId);
    addBackgroundPhases(b, event, bgStart, bgSpan);
  } else if (event.context === 'background') {
    const end = event.timestamp;
    const start = end - event.totalMs;
    root = addSpan(b, 'image.process', start, end, undefined, attributes, rootStatus(event));
    addBackgroundPhases(b, event, start, root);
  } else {
    const end = event.timestamp;
    const start = end - event.totalMs;
    root = addSpan(b, 'image.process', start, end, undefined, attributes, rootStatus(event));
    addContentPhases(b, event, start, root);
  }

  const logRecord: OtlpLogRecord = {
    timeUnixNano: root.endTimeUnixNano,
    severityNumber: event.status === 'error' ? SEVERITY.error : SEVERITY.info,
    severityText: event.status === 'error' ? 'ERROR' : 'INFO',
    body: { stringValue: `${event.status} ${event.hostname} +${event.totalMs}ms` },
    attributes,
    traceId,
    spanId: root.spanId,
  };

  return { spans: b.spans, logRecord };
};
