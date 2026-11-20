import { describe, expect, it, vi } from 'vitest';

import { LookaheadHostService } from '@/entrypoints/background/services/lookaheadHostService';
import { LOOKAHEAD_PORT_NAME, type FirefoxPortMessage, type OpenAnalysis } from '@/utils/lookahead/protocol';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type { VideoPredictionCacheService } from '@/entrypoints/background/services/videoPredictionCacheService';

const OBJECT_URL = 'blob:https://example.test/source';

const openMse: OpenAnalysis = {
  t: 'open',
  sessionId: 'session',
  tap: { kind: 'mse', objectUrl: OBJECT_URL },
  liveness: 'live',
  inputSize: 64,
  readContext: { identity: { kind: 'unknown' }, aspectRatio: null },
  origin: { sourceUrl: OBJECT_URL, pageUrl: 'https://example.test/watch', hostname: 'example.test' },
  scoreThreshold: 0.5,
};

type ConnectListener = (port: Browser.runtime.Port) => void;

const openIdentifiedVod: OpenAnalysis = {
  ...openMse,
  liveness: 'vod',
  readContext: { identity: { kind: 'stable', key: 'yt:abc', durationSec: 60 }, aspectRatio: 16 / 9 },
};

function connectContentScript(sender?: Browser.runtime.MessageSender) {
  let onConnect: ConnectListener | undefined;
  vi.spyOn(browser.runtime.onConnect, 'addListener').mockImplementation(listener => {
    onConnect = listener;
  });
  const getCached = vi.fn(() => Promise.resolve({ samples: [] }));
  new LookaheadHostService(
    {} as InferenceOrchestrationService,
    {} as HostSettingsService,
    { getCached } as unknown as VideoPredictionCacheService,
  ).listen();

  const messageListeners: ((message: unknown) => void)[] = [];
  const posted: unknown[] = [];
  const port = {
    name: LOOKAHEAD_PORT_NAME,
    sender,
    postMessage: (message: unknown) => posted.push(message),
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
    onDisconnect: { addListener: () => {} },
  };
  onConnect?.(port as unknown as Browser.runtime.Port);
  const fromContent = (message: FirefoxPortMessage) => messageListeners.forEach(listener => listener(message));
  return { posted, fromContent, getCached };
}

describe('Lookahead host service: the Firefox event page end of the relay', () => {
  it('opens an MSE session on a hooked source relayed by the content script and wants its bytes', async () => {
    const { posted, fromContent } = connectContentScript();

    fromContent({ k: 'hook', m: { t: 'source', sourceId: 1, objectUrl: OBJECT_URL, liveness: 'vod' } });
    fromContent({ k: 'content', m: openMse });

    await vi.waitFor(() =>
      expect(posted).toEqual([
        { t: 'reachable', sessionId: 'session', tap: 'mse' },
        { t: 'toHook', command: { t: 'want', sourceId: 1 } },
      ]),
    );
  });

  it('reports the session unreachable when the hook answers with an overflowed backlog', async () => {
    const { posted, fromContent } = connectContentScript();
    fromContent({ k: 'hook', m: { t: 'source', sourceId: 1, objectUrl: OBJECT_URL, liveness: 'vod' } });
    fromContent({ k: 'content', m: openMse });
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    fromContent({ k: 'hook', m: { t: 'overflow', sourceId: 1 } });

    expect(posted).toContainEqual({ t: 'unreachable', sessionId: 'session', reason: 'overflow' });
  });

  const openIdentifiedVodFrom = async (sender: Browser.runtime.MessageSender) => {
    const { posted, fromContent, getCached } = connectContentScript(sender);
    fromContent({ k: 'hook', m: { t: 'source', sourceId: 1, objectUrl: OBJECT_URL, liveness: 'vod' } });
    fromContent({ k: 'content', m: openIdentifiedVod });
    await vi.waitFor(() => expect(posted).toContainEqual({ t: 'reachable', sessionId: 'session', tap: 'mse' }));
    return getCached;
  };

  it('reads the sample cache for an identified video in a normal tab', async () => {
    const getCached = await openIdentifiedVodFrom({
      tab: { id: 1, incognito: false },
    } as Browser.runtime.MessageSender);

    await vi.waitFor(() => expect(getCached).toHaveBeenCalled());
  });

  it('keeps an incognito tab away from the sample cache', async () => {
    const getCached = await openIdentifiedVodFrom({ tab: { id: 1, incognito: true } } as Browser.runtime.MessageSender);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(getCached).not.toHaveBeenCalled();
  });
});
