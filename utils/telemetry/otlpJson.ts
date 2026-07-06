import type { OtlpAnyValue, OtlpKeyValue } from '@/utils/telemetry/types';

const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** 16 random bytes as 32 lowercase hex chars. */
export const newTraceId = (): string => toHex(crypto.getRandomValues(new Uint8Array(16)));

/** 8 random bytes as 16 lowercase hex chars. */
export const newSpanId = (): string => toHex(crypto.getRandomValues(new Uint8Array(8)));

/**
 * Epoch milliseconds → OTLP nanosecond string. BigInt because nano epoch values
 * exceed 2^53; the result must be serialized as a decimal string, never a number.
 */
export const msToNano = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString();

/** OTLP SeverityNumber per level. */
export const SEVERITY: Record<'debug' | 'info' | 'warn' | 'error', number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

const toAnyValue = (value: string | number | boolean): OtlpAnyValue => {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
};

/** Flat record → OTLP attribute list; undefined/null entries are skipped. */
export const toAttributes = (obj: Record<string, string | number | boolean | undefined | null>): OtlpKeyValue[] => {
  const attributes: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    attributes.push({ key, value: toAnyValue(value) });
  }
  return attributes;
};
