import {
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';

import { generateNonce } from '@/utils/nonce';
import {
  ATTR,
  errorAttributes,
  requestIdFor,
  type LooseAttributes,
  sanitizeAttributes,
} from '@/utils/telemetry/attributes';
import { contextWithSpan, extractTraceparent, spanIdsFromContext } from '@/utils/telemetry/propagation';
import { getTracer } from '@/utils/telemetry/tracer';

export const SPAN = {
  roundtrip: 'inference.roundtrip',
  capture: 'inference.capture',
  send: 'inference.send',
  queueWait: 'inference.queue.wait',
  run: 'inference.run',
  cache: 'inference.cache',
  apply: 'inference.apply',
  pageSession: 'page.session',
  videoSession: 'video.session',
  dvrWarmup: 'video.dvr.warmup',
} as const;

export type MediaKind = 'image' | 'gif' | 'frame';
export type RoundtripStatus = 'success' | 'error' | 'skipped' | 'cached';
export type RoundtripCancelReason = 'cancelled' | 'evicted' | 'disposed';

export interface UmbrellaSession {
  sessionId: string;
  spanContext?: SpanContext;
}

interface ActiveRoundtrip {
  span: Span;
  ctx: Context;
  children: Map<string, Span>;
}

const MAX_ACTIVE_ROUNDTRIPS = 500;

const tracer = getTracer('inference');
const active = new Map<string, ActiveRoundtrip>();
let umbrella: UmbrellaSession = { sessionId: 'none' };

export function startUmbrellaSession(name: string, attributes: LooseAttributes = {}): UmbrellaSession {
  const sessionId = generateNonce();
  const span = tracer.startSpan(name, {
    attributes: { ...sanitizeAttributes(attributes), [ATTR.sessionId]: sessionId },
  });
  const spanContext = span.spanContext();
  span.end();
  return { sessionId, spanContext: isSpanContextValid(spanContext) ? spanContext : undefined };
}

export function umbrellaContext(session: UmbrellaSession): Context | undefined {
  return session.spanContext ? trace.setSpanContext(ROOT_CONTEXT, session.spanContext) : undefined;
}

export function setPageSession(session: UmbrellaSession): void {
  umbrella = session;
}

export function getPageSession(): UmbrellaSession {
  return umbrella;
}

export interface RoundtripStart {
  src: string;
  hostname: string;
  mediaKind: MediaKind;
  session?: UmbrellaSession;
  attributes?: LooseAttributes;
}

export function startRoundtrip(key: string, start: RoundtripStart): Context {
  const existing = active.get(key);
  if (existing) return existing.ctx;

  const session = start.session ?? umbrella;
  const span = tracer.startSpan(
    SPAN.roundtrip,
    {
      attributes: {
        [ATTR.reqId]: requestIdFor(start.src),
        [ATTR.src]: start.src,
        [ATTR.hostname]: start.hostname,
        [ATTR.mediaKind]: start.mediaKind,
        [ATTR.sessionId]: session.sessionId,
        ...(session.spanContext ? { [ATTR.sessionTraceId]: session.spanContext.traceId } : {}),
        ...sanitizeAttributes(start.attributes),
      },
      links: session.spanContext ? [{ context: session.spanContext }] : [],
    },
    ROOT_CONTEXT,
  );
  const ctx = contextWithSpan(span);
  active.set(key, { span, ctx, children: new Map() });
  evictOldestRoundtrips();
  return ctx;
}

function evictOldestRoundtrips(): void {
  for (const key of active.keys()) {
    if (active.size <= MAX_ACTIVE_ROUNDTRIPS) return;
    cancelRoundtrip(key, 'evicted');
  }
}

export function getRoundtripContext(key: string): Context | undefined {
  return active.get(key)?.ctx;
}

export function roundtripMatches(key: string, traceparent: string | undefined): boolean {
  const roundtrip = active.get(key);
  if (!roundtrip) return false;
  if (!traceparent) return true;
  const replyTraceId = spanIdsFromContext(extractTraceparent(traceparent)).traceId;
  return replyTraceId === roundtrip.span.spanContext().traceId;
}

export function startRoundtripChild(key: string, name: string, attributes?: LooseAttributes): Span | undefined {
  const roundtrip = active.get(key);
  if (!roundtrip) return undefined;
  endRoundtripChild(key, name);
  const span = tracer.startSpan(name, { attributes: sanitizeAttributes(attributes) }, roundtrip.ctx);
  roundtrip.children.set(name, span);
  return span;
}

export function endRoundtripChild(key: string, name: string, attributes?: LooseAttributes): void {
  const roundtrip = active.get(key);
  const child = roundtrip?.children.get(name);
  if (!roundtrip || !child) return;
  if (attributes) child.setAttributes(sanitizeAttributes(attributes));
  child.end();
  roundtrip.children.delete(name);
}

export interface RoundtripEnd {
  status: RoundtripStatus;
  error?: unknown;
  attributes?: LooseAttributes;
}

export function endRoundtrip(key: string, end: RoundtripEnd): void {
  const roundtrip = active.get(key);
  if (!roundtrip) return;
  active.delete(key);
  for (const child of roundtrip.children.values()) child.end();
  roundtrip.span.setAttributes({ ...sanitizeAttributes(end.attributes), [ATTR.status]: end.status });
  if (end.status === 'error') {
    roundtrip.span.setAttributes(sanitizeAttributes(errorAttributes(end.error)));
    roundtrip.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: end.error instanceof Error ? end.error.message : undefined,
    });
  } else {
    roundtrip.span.setStatus({ code: SpanStatusCode.OK });
  }
  roundtrip.span.end();
}

export function cancelRoundtrip(key: string, reason: RoundtripCancelReason = 'cancelled'): void {
  const roundtrip = active.get(key);
  if (!roundtrip) return;
  active.delete(key);
  for (const child of roundtrip.children.values()) child.end();
  roundtrip.span.setAttribute(ATTR.status, reason);
  roundtrip.span.end();
}

export function cancelAllRoundtrips(reason: RoundtripCancelReason): void {
  for (const key of Array.from(active.keys())) cancelRoundtrip(key, reason);
}

export function endSpanWithError(span: Span, error: unknown): void {
  span.setAttributes(sanitizeAttributes(errorAttributes(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
  span.end();
}
