import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MSE_HOOK_HANDSHAKE, type HookCommand, type HookMessage, type OpenAnalysis } from '@/utils/lookahead/protocol';

import type { LookaheadHandlers } from '@/entrypoints/content/video/tap/lookaheadClient';

vi.mock('@/utils/constants/environment', () => ({ IS_CHROME: false }));
vi.mock('@/utils/messaging/content', () => ({ backgroundRpc: {} }));

const OBJECT_URL = 'blob:https://example.test/source';

const openMse: OpenAnalysis = {
  t: 'open',
  sessionId: 'session',
  tap: { kind: 'mse', objectUrl: OBJECT_URL },
  liveness: 'vod',
  suspicionThreshold: 0.25,
  inputSize: 64,
  cacheKey: 'https://example.test/watch',
  sourceUrl: OBJECT_URL,
  hostname: 'example.test',
  scoreThreshold: 0.5,
};

type Listener<T extends unknown[]> = (...args: T) => void;

function createRuntimePort() {
  const messageListeners: Listener<[unknown]>[] = [];
  const disconnectListeners: Listener<[]>[] = [];
  const posted: unknown[] = [];
  return {
    port: {
      name: 'hb-lookahead',
      postMessage: (message: unknown) => posted.push(message),
      onMessage: { addListener: (listener: Listener<[unknown]>) => messageListeners.push(listener) },
      onDisconnect: { addListener: (listener: Listener<[]>) => disconnectListeners.push(listener) },
    },
    posted,
    fromHost: (message: unknown) => messageListeners.forEach(listener => listener(message)),
    disconnect: () => disconnectListeners.forEach(listener => listener()),
  };
}

function createWindow() {
  const offeredPorts: MessagePort[] = [];
  const target = Object.assign(new EventTarget(), {
    postMessage(data: unknown, _origin: string, transfer: Transferable[] = []) {
      const ports = transfer.filter((item): item is MessagePort => item instanceof MessagePort);
      if ((data as Record<string, unknown>)[MSE_HOOK_HANDSHAKE] === 'port') offeredPorts.push(...ports);
    },
  });
  return { target, offeredPorts };
}

const handlersStub = (): LookaheadHandlers & { unreachableReasons: string[] } => {
  const unreachableReasons: string[] = [];
  return {
    unreachableReasons,
    reachable: () => {},
    unreachable: reason => unreachableReasons.push(reason),
    sample: () => {},
    stat: () => {},
    infer: () => Promise.resolve(null),
  };
};

let page: ReturnType<typeof createWindow>;
let runtime: ReturnType<typeof createRuntimePort>;

beforeEach(() => {
  vi.resetModules();
  page = createWindow();
  runtime = createRuntimePort();
  vi.stubGlobal('window', page.target);
  vi.spyOn(browser.runtime, 'connect').mockReturnValue(runtime.port as unknown as Browser.runtime.Port);
});

afterEach(() => {
  for (const port of page.offeredPorts) port.close();
  vi.unstubAllGlobals();
});

const openSession = async (handlers: LookaheadHandlers) => {
  const { openLookahead } = await import('@/entrypoints/content/video/tap/lookaheadClient');
  openLookahead(openMse, handlers);
  const [hookSide] = page.offeredPorts;
  if (!hookSide) throw new Error('no hook port offered');
  return hookSide;
};

describe('Lookahead client on Firefox: relaying the MSE hook to the event page', () => {
  it('forwards hook messages over runtime.connect, after the open', async () => {
    const hookSide = await openSession(handlersStub());
    const source: HookMessage = { t: 'source', sourceId: 1, objectUrl: OBJECT_URL, liveness: 'vod' };

    hookSide.postMessage(source);

    await vi.waitFor(() =>
      expect(runtime.posted).toEqual([
        { k: 'content', m: openMse },
        { k: 'hook', m: source },
      ]),
    );
  });

  it("delivers the event page's hook commands to the hook", async () => {
    const hookSide = await openSession(handlersStub());
    const commands: HookCommand[] = [];
    hookSide.onmessage = (event: MessageEvent<HookCommand>) => commands.push(event.data);

    runtime.fromHost({ t: 'toHook', command: { t: 'want', sourceId: 1 } });

    await vi.waitFor(() => expect(commands).toEqual([{ t: 'want', sourceId: 1 }]));
  });

  it('reports every open session unreachable when the event page port disconnects', async () => {
    const handlers = handlersStub();
    await openSession(handlers);

    runtime.disconnect();

    expect(handlers.unreachableReasons).toEqual(['hook']);
  });
});
