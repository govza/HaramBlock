import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { CompositeProvideAdapter } from '@/utils/messaging/adapters/compositeProvideAdapter';
import { getRpcContext, type RpcContext } from '@/utils/messaging/rpcContext';

type GlobalMessageListener = (event: { data: unknown; ports: unknown[] }) => void;

const makePort = () => ({
  postMessage: vi.fn(),
  close: vi.fn(),
  onmessage: null as ((event: { data: unknown }) => void) | null,
  onmessageerror: null,
});

const INCOGNITO_SENDER = { tab: { id: 5, url: 'https://example.com/', incognito: true }, frameId: 0 };

const deliverRuntimeMessage = (message: unknown): Promise<void> =>
  fakeBrowser.runtime.onMessage.trigger(message, INCOGNITO_SENDER as never, () => {}).then(() => undefined);

describe('CompositeProvideAdapter caller identity', () => {
  let announcePort: GlobalMessageListener;
  let callersSeen: RpcContext[];

  beforeEach(() => {
    fakeBrowser.reset();
    vi.stubGlobal('addEventListener', (_type: string, listener: GlobalMessageListener) => {
      announcePort = listener;
    });
    callersSeen = [];
    void new CompositeProvideAdapter().onMessage(() => {
      callersSeen.push(getRpcContext());
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openChannel = (secret: string) => {
    const port = makePort();
    announcePort({ data: { type: 'PORT_READY', secret }, ports: [port] });
    return port;
  };

  it('holds channel messages until the channel is registered, then handles them for the registering tab', async () => {
    const port = openChannel('secret-1');

    port.onmessage?.({ data: { id: 'early', meta: { url: 'https://example.com/' } } });
    expect(callersSeen).toEqual([]);

    await deliverRuntimeMessage({ type: 'REGISTER_CHANNEL_TAB', secret: 'secret-1' });
    expect(callersSeen).toEqual([{ tabId: 5, frameId: 0, incognito: true }]);

    port.onmessage?.({ data: { id: 'late', meta: { url: 'https://example.com/' } } });
    expect(callersSeen).toHaveLength(2);
    expect(callersSeen[1]).toEqual({ tabId: 5, frameId: 0, incognito: true });
  });

  it('handles held messages as an incognito caller when the channel is never registered', () => {
    vi.useFakeTimers();
    const port = openChannel('secret-3');
    port.onmessage?.({ data: { id: 'early', meta: { url: 'https://example.com/' } } });

    vi.advanceTimersByTime(5000);

    expect(callersSeen).toEqual([{ incognito: true }]);
  });

  it('ignores a caller the content script puts in a channel message', async () => {
    const port = openChannel('secret-2');
    await deliverRuntimeMessage({ type: 'REGISTER_CHANNEL_TAB', secret: 'secret-2' });

    port.onmessage?.({ data: { id: 'forged', meta: { url: '', caller: { tabId: 5, frameId: 0, incognito: false } } } });

    expect(callersSeen).toEqual([{ tabId: 5, frameId: 0, incognito: true }]);
  });

  it('takes the caller of a runtime message from its sender, not from the message', async () => {
    await deliverRuntimeMessage({
      id: 'runtime',
      meta: { url: '', caller: { tabId: 5, frameId: 0, incognito: false } },
    });

    expect(callersSeen).toEqual([{ tabId: 5, frameId: 0, incognito: true }]);
  });
});
