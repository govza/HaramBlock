import { ROOT_CONTEXT, trace, TraceFlags, type Context, type Span, type SpanContext } from '@opentelemetry/api';

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

export function contextWithSpan(span: Span): Context {
  return trace.setSpan(ROOT_CONTEXT, span);
}

export function traceparentFromSpanContext(spanContext: SpanContext | undefined): string | undefined {
  if (!spanContext) return undefined;
  if (spanContext.traceId === INVALID_TRACE_ID || spanContext.spanId === INVALID_SPAN_ID) return undefined;
  const flags = (spanContext.traceFlags & TraceFlags.SAMPLED).toString(16).padStart(2, '0');
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

export function injectTraceparent(ctx: Context | undefined): string | undefined {
  if (!ctx) return undefined;
  return traceparentFromSpanContext(trace.getSpanContext(ctx));
}

export function extractTraceparent(traceparent: string | undefined): Context {
  if (!traceparent) return ROOT_CONTEXT;
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (!match) return ROOT_CONTEXT;
  const [, traceId, spanId, flags] = match;
  if (!traceId || !spanId || !flags || traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) {
    return ROOT_CONTEXT;
  }
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16) & TraceFlags.SAMPLED,
    isRemote: true,
  });
}

export function spanIdsFromContext(ctx: Context | undefined): { traceId?: string; spanId?: string } {
  const spanContext = ctx ? trace.getSpanContext(ctx) : undefined;
  if (!spanContext || spanContext.traceId === INVALID_TRACE_ID) return {};
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
