import { describe, expect, it, vi } from 'vitest';

import { createHarness, fileSource, fixture, withUnknownSizes } from '@/utils/lookahead/__tests__/harness';
import { LookaheadHost } from '@/utils/lookahead/host';

import type { ByteRangeSource } from '@/utils/lookahead/ports';
import type { HookCommand, HostToContent, OpenAnalysis } from '@/utils/lookahead/protocol';

const VP9_MIME = 'video/webm; codecs="vp9"';
const OBJECT_URL = 'blob:https://example.test/source';

function createHost(rangeSource: ByteRangeSource = {} as ByteRangeSource) {
  const harness = createHarness();
  const sent: HostToContent[] = [];
  const commands: HookCommand[] = [];
  const host = new LookaheadHost({
    decoder: () => harness.ports.decoder,
    inference: () => harness.ports.inference,
    cache: () => harness.ports.cache,
    rangeSource: () => rangeSource,
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

describe('Lookahead host: opening an MSE session', () => {
  it('reports the hook unreachable when no source is announced for the object URL within 3 s', async () => {
    vi.useFakeTimers();
    try {
      const { host, sent, commands } = createHost();
      host.handleContent(openMse('session'));
      await vi.advanceTimersByTimeAsync(2_900);
      expect(sent).toEqual([]);

      await vi.advanceTimersByTimeAsync(200);

      expect(sent).toEqual([{ t: 'unreachable', sessionId: 'session', reason: 'hook' }]);
      expect(commands).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wants the source and analyses the history the hook replays, init segment included', async () => {
    const { host, harness, sent, commands } = createHost();
    host.handleContent(openMse('session'));
    host.handleHook({ t: 'source', sourceId: 1, objectUrl: OBJECT_URL, live: false });
    await vi.waitFor(() => expect(commands).toEqual([{ t: 'want', sourceId: 1 }]));
    expect(reachableSessions(sent)).toEqual(['session']);

    host.handleHook({ t: 'buffer', sourceId: 1, bufferId: 2, mime: VP9_MIME });
    host.handleHook({
      t: 'append',
      sourceId: 1,
      bufferId: 2,
      bytes: fixture('mse-vp9.webm').slice().buffer,
      timestampOffset: 0,
    });

    await vi.waitFor(() =>
      expect(harness.requestedPoints()).toEqual([
        0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000,
      ]),
    );
  });

  it("analyses a buffer's trailing unit once the hook reports its stream ended", async () => {
    const { host, harness, commands } = createHost();
    host.handleContent(openMse('session'));
    host.handleHook({ t: 'source', sourceId: 1, objectUrl: OBJECT_URL, live: false });
    await vi.waitFor(() => expect(commands).toEqual([{ t: 'want', sourceId: 1 }]));
    host.handleHook({ t: 'buffer', sourceId: 1, bufferId: 2, mime: VP9_MIME });
    host.handleHook({
      t: 'append',
      sourceId: 1,
      bufferId: 2,
      bytes: withUnknownSizes(fixture('mse-vp9.webm')).buffer,
      timestampOffset: 0,
    });
    await vi.waitFor(() => expect(harness.requestedPoints()).toContain(2_500_000));

    host.handleHook({ t: 'endOfStream', sourceId: 1, bufferId: 2 });

    await vi.waitFor(() => expect(harness.requestedPoints()).toContain(3_500_000));
  });

  it('reports a source whose pre-open backlog overflowed unreachable and drops it', async () => {
    const { host, sent, commands } = createHost();
    host.handleHook({ t: 'source', sourceId: 1, objectUrl: OBJECT_URL, live: false });
    host.handleContent(openMse('session'));
    await vi.waitFor(() => expect(commands).toEqual([{ t: 'want', sourceId: 1 }]));

    host.handleHook({ t: 'overflow', sourceId: 1 });

    expect(sent.at(-1)).toEqual({ t: 'unreachable', sessionId: 'session', reason: 'overflow' });
    expect(commands.at(-1)).toEqual({ t: 'drop', sourceId: 1 });
  });
});

const openProgressive = (sessionId: string): OpenAnalysis => ({
  ...openMse(sessionId),
  tap: { kind: 'progressive', url: 'https://example.test/video.mp4' },
  live: false,
});

describe('Lookahead host: opening a progressive session', () => {
  it('reports the progressive tap reachable only once the first range request succeeds', async () => {
    let answerFirstRange: (size: number) => void = () => undefined;
    const bytes = fixture('progressive-short-gop.mp4');
    const { source } = fileSource(bytes);
    const { host, sent } = createHost({
      size: () => new Promise(resolve => (answerFirstRange = resolve)),
      read: (start, end) => source.read(start, end),
    });
    host.handleContent(openProgressive('session'));
    await Promise.resolve();
    expect(sent).toEqual([]);

    answerFirstRange(bytes.length);

    await vi.waitFor(() => expect(sent[0]).toEqual({ t: 'reachable', sessionId: 'session', tap: 'progressive' }));
  });

  it('reports a rejected first range request unreachable without ever reporting it reachable', async () => {
    const { source } = fileSource(fixture('progressive-short-gop.mp4'), { failFirst: true });
    const { host, sent } = createHost(source);
    host.handleContent(openProgressive('session'));

    await vi.waitFor(() => expect(sent).toEqual([{ t: 'unreachable', sessionId: 'session', reason: 'fetch' }]));
  });
});
