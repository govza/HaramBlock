import { ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { extractTraceparent, injectTraceparent } from '@/utils/telemetry/propagation';

describe('traceparent propagation', () => {
  const remote = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    traceFlags: TraceFlags.SAMPLED,
  });

  it('survives an inject -> serialize -> extract hop with the same ids', () => {
    const header = injectTraceparent(remote);
    expect(header).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

    const envelope = JSON.parse(JSON.stringify({ traceparent: header })) as { traceparent: string };
    const restored = trace.getSpanContext(extractTraceparent(envelope.traceparent));

    expect(restored?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(restored?.spanId).toBe('00f067aa0ba902b7');
    expect(restored?.traceFlags).toBe(TraceFlags.SAMPLED);
    expect(restored?.isRemote).toBe(true);
  });

  it('yields no header for a context without a span (noop tracer in prod)', () => {
    expect(injectTraceparent(ROOT_CONTEXT)).toBeUndefined();
    expect(injectTraceparent(undefined)).toBeUndefined();
  });

  it('falls back to the root context on a malformed or missing header', () => {
    const allZero = `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`;
    expect(trace.getSpanContext(extractTraceparent(undefined))).toBeUndefined();
    expect(trace.getSpanContext(extractTraceparent('garbage'))).toBeUndefined();
    expect(trace.getSpanContext(extractTraceparent(allZero))).toBeUndefined();
  });
});
