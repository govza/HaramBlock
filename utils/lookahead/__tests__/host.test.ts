import { describe, expect, it, vi } from 'vitest';

import { createHarness, fixture } from '@/utils/lookahead/__tests__/harness';
import { LookaheadHost } from '@/utils/lookahead/host';

import type { ByteRangeSource } from '@/utils/lookahead/ports';
import type { HookCommand, HostToContent, OpenAnalysis } from '@/utils/lookahead/protocol';

const VP9_MIME = 'video/webm; codecs="vp9"';
const OBJECT_URL = 'blob:https://example.test/source';

function createHost() {
  const harness = createHarness();
  const sent: HostToContent[] = [];
  const commands: HookCommand[] = [];
  const host = new LookaheadHost({
    decoder: () => harness.ports.decoder,
    inference: () => harness.ports.inference,
    cache: () => harness.ports.cache,
    rangeSource: () => ({}) as ByteRangeSource,
    send: message => sent.push(message),
    toHook: command => commands.push(command),
  });
  return { host, harness, sent, commands };
}

const openMse = (sessionId: string): OpenAnalysis => ({
  t: 'open',
  sessionId,
  tap: { kind: 'mse', objectUrl: OBJECT_URL },
  live: true,
  suspicionThreshold: 0.25,
  inputSize: 64,
  cacheKey: '',
  sourceUrl: OBJECT_URL,
  hostname: 'example.test',
  scoreThreshold: 0.5,
});

const reachableSessions = (sent: HostToContent[]) =>
  sent.filter(message => message.t === 'reachable').map(message => message.sessionId);

describe('Lookahead host: reopening a session on the same MSE source', () => {
  it('analyses bytes appended after the reopen, though the buffer and its init segment came before it', async () => {
    const { host, harness, sent } = createHost();
    const bytes = fixture('mse-vp9.webm');
    const half = Math.floor(bytes.length / 2);
    host.handleHook({ t: 'source', sourceId: 1, objectUrl: OBJECT_URL, live: false });
    host.handleContent(openMse('first'));
    await vi.waitFor(() => expect(reachableSessions(sent)).toEqual(['first']));
    host.handleHook({ t: 'buffer', sourceId: 1, bufferId: 2, mime: VP9_MIME });
    host.handleHook({ t: 'append', sourceId: 1, bufferId: 2, bytes: bytes.slice(0, half).buffer, timestampOffset: 0 });
    await vi.waitFor(() => expect(harness.requests.length).toBeGreaterThan(0));
    const firstPoints = new Set(harness.requestedPoints());

    host.handleContent({ t: 'close', sessionId: 'first' });
    host.handleContent(openMse('second'));
    await vi.waitFor(() => expect(reachableSessions(sent)).toEqual(['first', 'second']));
    host.handleHook({ t: 'append', sourceId: 1, bufferId: 2, bytes: bytes.slice(half).buffer, timestampOffset: 0 });

    await vi.waitFor(() =>
      expect(harness.requestedPoints().filter(point => !firstPoints.has(point)).length).toBeGreaterThan(0),
    );
  });

  it('never reports an abandoned open as unreachable once the session has reopened on another source', async () => {
    vi.useFakeTimers();
    try {
      const { host, sent } = createHost();
      host.handleContent({ ...openMse('session'), tap: { kind: 'mse', objectUrl: 'blob:https://example.test/old' } });
      host.handleHook({ t: 'source', sourceId: 1, objectUrl: OBJECT_URL, live: false });
      host.handleContent(openMse('session'));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sent.map(message => message.t)).toEqual(['reachable']);
    } finally {
      vi.useRealTimers();
    }
  });
});
