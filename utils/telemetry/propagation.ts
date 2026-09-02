import { isSpanContextValid, ROOT_CONTEXT, trace, type Context, type Span } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const propagator = new W3CTraceContextPropagator();
const TRACEPARENT_HEADER = 'traceparent';

const carrierGetter = {
  keys: (carrier: Record<string, string>) => Object.keys(carrier),
  get: (carrier: Record<string, string>, key: string) => carrier[key],
};

const carrierSetter = {
  set: (carrier: Record<string, string>, key: string, value: string) => {
    carrier[key] = value;
  },
};

export function contextWithSpan(span: Span): Context {
  return trace.setSpan(ROOT_CONTEXT, span);
}

export function injectTraceparent(ctx: Context | undefined): string | undefined {
  if (!ctx) return undefined;
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, carrierSetter);
  return carrier[TRACEPARENT_HEADER];
}

export function extractTraceparent(traceparent: string | undefined): Context {
  if (!traceparent) return ROOT_CONTEXT;
  return propagator.extract(ROOT_CONTEXT, { [TRACEPARENT_HEADER]: traceparent }, carrierGetter);
}

export function spanIdsFromContext(ctx: Context | undefined): { traceId?: string; spanId?: string } {
  const spanContext = ctx ? trace.getSpanContext(ctx) : undefined;
  if (!spanContext || !isSpanContextValid(spanContext)) return {};
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
