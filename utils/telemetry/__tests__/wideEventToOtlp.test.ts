import { describe, expect, it } from 'vitest';

import { wideEventToOtlp } from '@/utils/telemetry/wideEventToOtlp';

import type { WideEvent } from '@/utils/logging/types';
import type { OtlpSpan } from '@/utils/telemetry/types';

const TRACE_ID = 'a'.repeat(32);

const baseEvent: WideEvent = {
  reqId: 'f7a2',
  src: 'https://example.com/img.jpg',
  hostname: 'example.com',
  context: 'background',
  timestamp: 1_720_000_000_000,
  status: 'success',
  totalMs: 200,
  version: '1.0.0',
};

const byName = (spans: OtlpSpan[], name: string): OtlpSpan | undefined => spans.find(s => s.name === name);
const nano = (ms: number): string => `${ms}000000`;

describe('wideEventToOtlp', () => {
  it('maps a merged event to the full content+background span tree', () => {
    const merged: WideEvent = {
      ...baseEvent,
      queueMs: 10,
      fetchMs: 20,
      decodeMs: 30,
      inferenceMs: 100,
      sendMs: 5,
      waitMs: 220,
      styleMs: 15,
      contentTimestamp: 1_720_000_000_050,
      contentTotalMs: 240,
    };
    const { spans, logRecord } = wideEventToOtlp(merged, TRACE_ID);

    expect(spans.map(s => s.name)).toEqual([
      'image.process',
      'content.send',
      'content.wait',
      'content.style',
      'background.process',
      'background.queue',
      'background.fetch',
      'background.decode',
      'background.inference',
    ]);

    const root = byName(spans, 'image.process')!;
    const contentStart = 1_720_000_000_050 - 240;
    expect(root.startTimeUnixNano).toBe(nano(contentStart));
    expect(root.endTimeUnixNano).toBe(nano(1_720_000_000_050));
    expect(root.parentSpanId).toBeUndefined();
    expect(root.status).toEqual({ code: 1 });

    // send [start, +5], wait [start+5, +220], style [start+225, +15]
    const send = byName(spans, 'content.send')!;
    const wait = byName(spans, 'content.wait')!;
    const style = byName(spans, 'content.style')!;
    expect(send.startTimeUnixNano).toBe(nano(contentStart));
    expect(wait.startTimeUnixNano).toBe(nano(contentStart + 5));
    expect(style.startTimeUnixNano).toBe(nano(contentStart + 225));
    expect(send.parentSpanId).toBe(root.spanId);
    expect(wait.parentSpanId).toBe(root.spanId);

    // background.process nests under content.wait; phases chain sequentially
    const bg = byName(spans, 'background.process')!;
    expect(bg.parentSpanId).toBe(wait.spanId);
    const bgStart = 1_720_000_000_000 - 200;
    expect(bg.startTimeUnixNano).toBe(nano(bgStart));
    expect(byName(spans, 'background.queue')!.startTimeUnixNano).toBe(nano(bgStart));
    expect(byName(spans, 'background.fetch')!.startTimeUnixNano).toBe(nano(bgStart + 10));
    expect(byName(spans, 'background.decode')!.startTimeUnixNano).toBe(nano(bgStart + 30));
    expect(byName(spans, 'background.inference')!.startTimeUnixNano).toBe(nano(bgStart + 60));
    expect(byName(spans, 'background.inference')!.endTimeUnixNano).toBe(nano(bgStart + 160));

    // Every span belongs to the trace
    expect(spans.every(s => s.traceId === TRACE_ID)).toBe(true);

    // Wide log record correlates to the root span
    expect(logRecord.traceId).toBe(TRACE_ID);
    expect(logRecord.spanId).toBe(root.spanId);
    expect(logRecord.severityNumber).toBe(9);
    expect(logRecord.body).toEqual({ stringValue: 'success example.com +200ms' });
  });

  it('maps a cached background event to a single root span', () => {
    const cached: WideEvent = { ...baseEvent, status: 'cached', cacheHit: true, totalMs: 3 };
    const { spans } = wideEventToOtlp(cached, TRACE_ID);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('image.process');
    expect(spans[0]!.attributes).toContainEqual({ key: 'cache_hit', value: { boolValue: true } });
  });

  it('marks error events with status code 2 and the error message', () => {
    const errored: WideEvent = {
      ...baseEvent,
      context: 'content',
      status: 'error',
      reason: 'decode-rejected',
      error: { message: 'decode failed', type: 'EncodingError' },
    };
    const { spans, logRecord } = wideEventToOtlp(errored, TRACE_ID);
    expect(spans[0]!.status).toEqual({ code: 2, message: 'decode failed' });
    expect(logRecord.severityNumber).toBe(17);
    expect(spans[0]!.attributes).toContainEqual({ key: 'reason', value: { stringValue: 'decode-rejected' } });
  });

  it('maps a content-only event to root + content phases', () => {
    const contentOnly: WideEvent = { ...baseEvent, context: 'content', sendMs: 5, waitMs: 100, styleMs: 10 };
    const { spans } = wideEventToOtlp(contentOnly, TRACE_ID);
    expect(spans.map(s => s.name)).toEqual(['image.process', 'content.send', 'content.wait', 'content.style']);
  });

  it('omits phase spans whose duration is missing', () => {
    const partial: WideEvent = { ...baseEvent, inferenceMs: 50 };
    const { spans } = wideEventToOtlp(partial, TRACE_ID);
    expect(spans.map(s => s.name)).toEqual(['image.process', 'background.inference']);
  });

  it('flattens the wide event into root span attributes', () => {
    const { spans } = wideEventToOtlp({ ...baseEvent, detectionsCount: 2, backend: 'webgpu' }, TRACE_ID);
    const attrs = spans[0]!.attributes;
    expect(attrs).toContainEqual({ key: 'req_id', value: { stringValue: 'f7a2' } });
    expect(attrs).toContainEqual({ key: 'detections_count', value: { intValue: '2' } });
    expect(attrs).toContainEqual({ key: 'backend', value: { stringValue: 'webgpu' } });
  });

  it('serializes without BigInt leakage', () => {
    const merged: WideEvent = { ...baseEvent, contentTimestamp: baseEvent.timestamp, contentTotalMs: 100 };
    expect(() => JSON.stringify(wideEventToOtlp(merged, TRACE_ID))).not.toThrow();
  });
});
