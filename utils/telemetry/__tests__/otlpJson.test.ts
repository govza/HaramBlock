import { describe, expect, it } from 'vitest';

import { msToNano, newSpanId, newTraceId, toAttributes, SEVERITY } from '@/utils/telemetry/otlpJson';

describe('msToNano', () => {
  it('converts epoch ms to a nanosecond decimal string without precision loss', () => {
    expect(msToNano(1719999999999)).toBe('1719999999999000000');
  });

  it('rounds fractional milliseconds', () => {
    expect(msToNano(10.6)).toBe('11000000');
  });

  it('returns a string (int64 fields must not be JSON numbers)', () => {
    expect(typeof msToNano(Date.now())).toBe('string');
  });
});

describe('id generation', () => {
  it('newTraceId is 32 lowercase hex chars', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('newSpanId is 16 lowercase hex chars', () => {
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('generates distinct ids', () => {
    expect(newTraceId()).not.toBe(newTraceId());
  });
});

describe('toAttributes', () => {
  it('types values per OTLP AnyValue rules', () => {
    expect(
      toAttributes({
        str: 'a',
        int: 5,
        float: 1.5,
        bool: true,
        missing: undefined,
        nil: null,
      }),
    ).toEqual([
      { key: 'str', value: { stringValue: 'a' } },
      { key: 'int', value: { intValue: '5' } },
      { key: 'float', value: { doubleValue: 1.5 } },
      { key: 'bool', value: { boolValue: true } },
    ]);
  });
});

describe('SEVERITY', () => {
  it('matches the OTLP SeverityNumber enum', () => {
    expect(SEVERITY).toEqual({ debug: 5, info: 9, warn: 13, error: 17 });
  });
});
