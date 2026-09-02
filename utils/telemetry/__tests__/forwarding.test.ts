import { describe, expect, it, vi } from 'vitest';

import { TelemetryForwarder } from '@/utils/telemetry/exporters/forwarding';

import type { TelemetryBatch, TelemetryLogRecord } from '@/utils/telemetry/records';

const sentEvents = (send: ReturnType<typeof vi.fn>, call: number): string[] =>
  (send.mock.calls[call]?.[0] as TelemetryBatch).logs.map(r => r.event);

const record = (event: string): TelemetryLogRecord => ({
  timeMs: 0,
  level: 'warn',
  scope: 'test',
  event,
  attributes: {},
  context: 'content',
});

describe('TelemetryForwarder', () => {
  it('keeps a batch for retry when send rejects', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('sw asleep')).mockResolvedValue(undefined);
    const forwarder = new TelemetryForwarder('content', send, 1000, 1000, 10);
    forwarder.pushLog(record('a'));

    await forwarder.flush();
    forwarder.pushLog(record('b'));
    await forwarder.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(sentEvents(send, 1)).toEqual(['a', 'b']);
  });

  it('drops the oldest records past the buffer cap', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const forwarder = new TelemetryForwarder('content', send, 1000, 1000, 2);
    ['a', 'b', 'c'].forEach(event => forwarder.pushLog(record(event)));

    await forwarder.flush();

    expect(sentEvents(send, 0)).toEqual(['b', 'c']);
  });
});
