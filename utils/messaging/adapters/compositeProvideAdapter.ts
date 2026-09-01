import { setRpcContext } from '@/utils/messaging/rpcContext';
import { getLogger } from '@/utils/telemetry';

import type { MessageMeta } from '@/utils/messaging/adapters/browserRuntimeAdapter';
import type { Adapter, Message, SendMessage, OnMessage } from 'comctx';

const log = getLogger('CompositeProvideAdapter');

interface MessageSender {
  tab?: { id?: number; url?: string };
  frameId?: number;
  url?: string;
}

interface PortInfo {
  port: MessagePort;
  secret: string;
  tabId?: number;
  frameId?: number;
}

/**
 * CompositeProvideAdapter combines browser.runtime messaging with MessageChannel transport.
 * This allows the background to receive messages from:
 * - Popup and Firefox content scripts via browser.runtime
 * - Chrome content scripts via MessageChannel (with transferable support)
 *
 * Responses are automatically routed back via the same transport that sent the request.
 */
export class CompositeProvideAdapter implements Adapter<MessageMeta> {
  private ports = new Map<string, PortInfo>();
  private messageCallbacks = new Set<(message?: Partial<Message<MessageMeta>>) => void>();

  constructor() {
    this.initializeBrowserRuntime();
    this.initializeMessageChannel();
    this.initializeTabCleanup();
  }

  private initializeBrowserRuntime(): void {
    browser.runtime.onMessage.addListener(
      (message: Partial<Message<MessageMeta>> | undefined, sender: MessageSender) => {
        const control = message as unknown as { type?: string; secret?: string } | undefined;
        if (control?.type === 'REGISTER_CHANNEL_TAB') {
          this.associateTab(control.secret, sender.tab?.id, sender.frameId);
          return;
        }

        const enrichedMessage = message
          ? {
              ...message,
              meta: {
                ...message.meta,
                tabId: sender.tab?.id,
                frameId: sender.frameId,
                url: sender.tab?.url || sender.url || '',
                // Mark as runtime transport for routing
                _transport: 'runtime' as const,
              } as MessageMeta & { _transport: 'runtime' },
            }
          : message;
        this.messageCallbacks.forEach(callback => callback(enrichedMessage));
      },
    );
    log.debug('rpc.runtime_listener_initialized');
  }

  private initializeMessageChannel(): void {
    globalThis.addEventListener('message', this.handleGlobalMessage);
    log.debug('channel.listener_initialized');
  }

  private handleGlobalMessage = (event: Event): void => {
    const evt = event as MessageEvent;
    const data = evt.data as { type?: string; secret?: string } | undefined;

    if (!data || data.type !== 'PORT_READY') return;

    const secret = data.secret || '';
    const ports = evt.ports || [];
    const port = ports[0];

    if (!secret || !port) {
      log.warn('channel.port_ready_missing_data');
      return;
    }

    // Store port info
    const portInfo: PortInfo = { port, secret };
    this.ports.set(secret, portInfo);

    // Wire up message handler
    port.onmessage = (msgEvent: MessageEvent) => {
      this.handlePortMessage(secret, msgEvent);
    };

    port.onmessageerror = () => {
      log.error('channel.port_message_error', { secret });
      this.removePort(secret);
    };

    // ACK to content script
    try {
      port.postMessage({ type: 'READY' });
    } catch (error) {
      log.error('channel.ack_failed', { error });
    }
  };

  private handlePortMessage(secret: string, event: MessageEvent): void {
    const data = event.data as Partial<Message<MessageMeta>> | undefined;
    if (!data) return;

    // The channel itself carries no sender info; tabId/frameId come from the
    // REGISTER_CHANNEL_TAB association done at channel establishment.
    const portInfo = this.ports.get(secret);

    // Enrich message with routing metadata
    const enrichedMessage: Partial<Message<MessageMeta>> = {
      ...data,
      meta: {
        ...data.meta,
        // Store secret for routing responses back via MessageChannel
        _channelSecret: secret,
        _transport: 'channel' as const,
        url: data.meta?.url || '',
        tabId: data.meta?.tabId ?? portInfo?.tabId,
        frameId: data.meta?.frameId ?? portInfo?.frameId,
      } as MessageMeta & { _channelSecret: string; _transport: 'channel' },
    };

    this.messageCallbacks.forEach(callback => callback(enrichedMessage));
  }

  private initializeTabCleanup(): void {
    browser.tabs.onRemoved.addListener(this.releaseTab);
    log.debug('rpc.tab_cleanup_listener_initialized');
  }

  /**
   * Close a port and drop it from the map. Closing detaches the handlers and lets the
   * browser reclaim the MessagePort; deleting the map entry alone leaves it entangled and
   * started, so a stale port (e.g. from a reloaded tab) can still deliver late messages.
   */
  private removePort(secret: string): void {
    const portInfo = this.ports.get(secret);
    if (!portInfo) return;

    portInfo.port.onmessage = null;
    portInfo.port.onmessageerror = null;
    try {
      portInfo.port.close();
    } catch {
      // Port already closed (e.g. its tab is gone) - nothing to do.
    }
    this.ports.delete(secret);
  }

  /**
   * Associate a channel secret with the tab AND frame that own it. Sent by the
   * content script over browser.runtime (which carries sender.tab.id/frameId)
   * once the channel is established. A reload or navigation produces a fresh
   * secret for the same frame, so that frame's previous port is stale and
   * removed here. Eviction must be per frame, not per tab: the content script
   * runs in all frames, and each frame owns its own live channel — evicting by
   * tab alone lets any iframe's registration kill the top frame's port.
   */
  private associateTab(secret: string | undefined, tabId?: number, frameId?: number): void {
    if (!secret || tabId === undefined) return;
    const portInfo = this.ports.get(secret);
    if (!portInfo) return;

    portInfo.tabId = tabId;
    portInfo.frameId = frameId;
    for (const [otherSecret, info] of this.ports) {
      if (otherSecret !== secret && info.tabId === tabId && info.frameId === frameId) {
        this.removePort(otherSecret);
      }
    }
  }

  /**
   * Drop every port owned by a closed tab. Without this, ports leak for the lifetime
   * of the service worker since posting to a closed tab's port does not throw.
   */
  private releaseTab = (tabId: number): void => {
    for (const [secret, info] of this.ports) {
      if (info.tabId === tabId) {
        this.removePort(secret);
      }
    }
  };

  sendMessage: SendMessage<MessageMeta> = async (message, transfer) => {
    const meta = message.meta as
      (MessageMeta & { _transport?: 'runtime' | 'channel'; _channelSecret?: string }) | undefined;
    const transport = meta?._transport;

    if (transport === 'channel') {
      // Route via MessageChannel
      const secret = meta?._channelSecret;
      if (!secret) {
        // No secret means this is likely a callback to a closed tab - silently ignore
        return;
      }

      const portInfo = this.ports.get(secret);
      if (!portInfo) {
        // Port was closed (tab closed/reloaded) - silently ignore like browser.runtime does
        return;
      }

      try {
        // Clean internal routing fields
        const cleanMessage = {
          ...message,
          meta: {
            ...message.meta,
            _channelSecret: undefined,
            _transport: undefined,
          },
        };

        if (transfer.length > 0) {
          portInfo.port.postMessage(cleanMessage, transfer);
        } else {
          portInfo.port.postMessage(cleanMessage);
        }
      } catch {
        // Port is dead - remove it and silently ignore (similar to "Receiving end does not exist")
        this.removePort(secret);
      }
    } else {
      // Route via browser.runtime
      const cleanMessage = {
        ...message,
        meta: {
          ...message.meta,
          _transport: undefined,
        },
      };

      switch (meta?.injector) {
        case 'content': {
          if (typeof meta.tabId === 'number' && meta.tabId >= 0) {
            await browser.tabs.sendMessage(meta.tabId, cleanMessage).catch((error: Error) => {
              // Tab might be closed - silently ignore
              if (error.message?.includes('Receiving end does not exist')) {
                return;
              }
              throw error;
            });
          } else if (meta.url) {
            const tabs = await browser.tabs.query({ url: meta.url });
            const tabIds = tabs.map(tab => tab.id).filter((id): id is number => id !== undefined);
            await Promise.all(
              tabIds.map(tabId =>
                browser.tabs.sendMessage(tabId, cleanMessage).catch((error: Error) => {
                  if (error.message?.includes('Receiving end does not exist')) {
                    return;
                  }
                  throw error;
                }),
              ),
            );
          }
          break;
        }
        case 'popup':
        default: {
          await browser.runtime.sendMessage(cleanMessage).catch((error: Error) => {
            if (error.message?.includes('Receiving end does not exist')) {
              return;
            }
            throw error;
          });
        }
      }
    }
  };

  onMessage: OnMessage<MessageMeta> = callback => {
    const wrapped = (message?: Partial<Message<MessageMeta>>) => {
      setRpcContext({ tabId: message?.meta?.tabId, frameId: message?.meta?.frameId });
      callback(message);
    };
    this.messageCallbacks.add(wrapped);
    return () => {
      this.messageCallbacks.delete(wrapped);
    };
  };

  /**
   * Get the number of active MessageChannel connections
   */
  getChannelConnectionCount(): number {
    return this.ports.size;
  }
}
