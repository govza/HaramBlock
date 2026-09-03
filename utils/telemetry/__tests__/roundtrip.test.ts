import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { beforeAll, describe, expect, it } from 'vitest';

import { injectTraceparent } from '@/utils/telemetry/propagation';
import { endRoundtrip, roundtripMatches, startRoundtrip } from '@/utils/telemetry/roundtrip';

const start = (key: string) => startRoundtrip(key, { src: key, hostname: 'example.com', mediaKind: 'image' });

describe('roundtripMatches', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
  });

  it('accepts a reply carrying the traceparent of the active round-trip', () => {
    const ctx = start('a.jpg');
    expect(roundtripMatches('a.jpg', injectTraceparent(ctx))).toBe(true);
    endRoundtrip('a.jpg', { status: 'success' });
  });

  it('rejects a reply from a superseded round-trip for the same src', () => {
    const stale = injectTraceparent(start('b.jpg'));
    endRoundtrip('b.jpg', { status: 'error' });
    start('b.jpg');
    expect(roundtripMatches('b.jpg', stale)).toBe(false);
    endRoundtrip('b.jpg', { status: 'success' });
  });

  it('falls back to src matching when the reply carries no traceparent', () => {
    start('c.jpg');
    expect(roundtripMatches('c.jpg', undefined)).toBe(true);
    endRoundtrip('c.jpg', { status: 'success' });
    expect(roundtripMatches('c.jpg', undefined)).toBe(false);
  });
});
