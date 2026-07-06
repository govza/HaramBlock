import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { OtlpExporter } from '@/utils/telemetry/otlpExporter';

import type { OtlpLogRecord, OtlpSpan } from '@/utils/telemetry/types';

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>>;

const span = (name: string): OtlpSpan => ({
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  name,
  kind: 1,
  startTimeUnixNano: '1000000',
  endTimeUnixNano: '2000000',
  attributes: [],
  status: { code: 1 },
});

const logRecord = (body: string): OtlpLogRecord => ({
  timeUnixNano: '1000000',
  severityNumber: 9,
  severityText: 'INFO',
  body: { stringValue: body },
  attributes: [],
});

const RESOURCE = [{ key: 'service.name', value: { stringValue: 'test' } }];

describe('OtlpExporter', () => {
  let fetchFn: FetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>>();
    fetchFn.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeExporter = (opts: Partial<ConstructorParameters<typeof OtlpExporter>[0]> = {}) =>
    new OtlpExporter({
      endpoint: 'http://localhost:4318',
      resourceAttributes: RESOURCE,
      fetchFn: fetchFn as unknown as typeof fetch,
      ...opts,
    });

  it('flushes on the timer with correct envelope, path and headers', async () => {
    const exporter = makeExporter();
    exporter.pushSpans([span('image.process')]);
    exporter.pushLog(logRecord('hello'));

    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [tracesUrl, tracesInit] = fetchFn.mock.calls.find(c => c[0].endsWith('/v1/traces'))!;
    expect(tracesUrl).toBe('http://localhost:4318/v1/traces');
    expect(tracesInit?.headers).toEqual({ 'Content-Type': 'application/json' });
    const tracesBody = JSON.parse(tracesInit?.body as string) as {
      resourceSpans: Array<{ resource: unknown; scopeSpans: Array<{ spans: unknown[] }> }>;
    };
    expect(tracesBody.resourceSpans[0]!.resource).toEqual({ attributes: RESOURCE });
    expect(tracesBody.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);

    const [logsUrl, logsInit] = fetchFn.mock.calls.find(c => c[0].endsWith('/v1/logs'))!;
    expect(logsUrl).toBe('http://localhost:4318/v1/logs');
    const logsBody = JSON.parse(logsInit?.body as string) as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }>;
    };
    expect(logsBody.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(1);
    exporter.dispose();
  });

  it('flushes early when the batch size is reached', async () => {
    const exporter = makeExporter({ maxBatch: 3 });
    exporter.pushSpans([span('a'), span('b'), span('c')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    exporter.dispose();
  });

  it('drops failed batches without throwing and rate-limits the warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
    const exporter = makeExporter();

    exporter.pushSpans([span('a')]);
    await vi.advanceTimersByTimeAsync(2000);
    exporter.pushSpans([span('b')]);
    await vi.advanceTimersByTimeAsync(2000);

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    exporter.dispose();
  });

  it('caps the queue by dropping oldest entries', async () => {
    const exporter = makeExporter({ maxQueue: 2, maxBatch: 100, flushIntervalMs: 1000 });
    exporter.pushSpans([span('a'), span('b'), span('c')]);
    await vi.advanceTimersByTimeAsync(1000);
    const [, init] = fetchFn.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
    };
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans.map(s => s.name)).toEqual(['b', 'c']);
    exporter.dispose();
  });

  it('does nothing after dispose', async () => {
    const exporter = makeExporter();
    exporter.dispose();
    exporter.pushSpans([span('a')]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
