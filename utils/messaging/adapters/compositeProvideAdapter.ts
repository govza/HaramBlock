import { logger } from '@/utils/logger';

import type { MessageMeta } from '@/utils/messaging/adapters/browserRuntimeAdapter';
import type { Adapter, Message, SendMessage, OnMessage } from 'comctx';

interface MessageSender {
  tab?: { id?: number; url?: string };
  url?: string;
}

interface PortInfo {
  port: MessagePort;
  secret: string;
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
  }

  private initializeBrowserRuntime(): void {
    browser.runtime.onMessage.addListener(
      (message: Partial<Message<MessageMeta>> | undefined, sender: MessageSender) => {
        const enrichedMessage = message
          ? {
              ...message,
              meta: {
                ...message.meta,
                tabId: sender.tab?.id,
                url: sender.tab?.url || sender.url || '',
                // Mark as runtime transport for routing
                _transport: 'runtime' as const,
              } as MessageMeta & { _transport: 'runtime' },
            }
          : message;
        this.messageCallbacks.forEach(callback => callback(enrichedMessage));
      },
    );
    logger.withTag('CompositeProvideAdapter').log('Browser runtime listener initialized');
  }

  private initializeMessageChannel(): void {
    globalThis.addEventListener('message', this.handleGlobalMessage);
    logger.withTag('CompositeProvideAdapter').log('MessageChannel listener initialized');
  }

  private handleGlobalMessage = (event: Event): void => {
    const evt = event as MessageEvent;
    const data = evt.data as { type?: string; secret?: string } | undefined;

    if (!data || data.type !== 'PORT_READY') return;

    const secret = data.secret || '';
    const ports = evt.ports || [];
    const port = ports[0];

    if (!secret || !port) {
      logger.withTag('CompositeProvideAdapter').warn('Missing secret or port on PORT_READY');
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
      logger.withTag('CompositeProvideAdapter').error('Port message error, removing:', secret);
      this.ports.delete(secret);
    };

    // ACK to content script
    try {
      port.postMessage({ type: 'READY' });
      logger.withTag('CompositeProvideAdapter').log('MessageChannel port established');
    } catch (error) {
      logger.withTag('CompositeProvideAdapter').error('Failed to ACK on port:', error);
    }
  };

  private handlePortMessage(secret: string, event: MessageEvent): void {
    const data = event.data as Partial<Message<MessageMeta>> | undefined;
    if (!data) return;

    // Enrich message with routing metadata
    const enrichedMessage: Partial<Message<MessageMeta>> = {
      ...data,
      meta: {
        ...data.meta,
        // Store secret for routing responses back via MessageChannel
        _channelSecret: secret,
        _transport: 'channel' as const,
        url: data.meta?.url || '',
        tabId: data.meta?.tabId,
      } as MessageMeta & { _channelSecret: string; _transport: 'channel' },
    };

    this.messageCallbacks.forEach(callback => callback(enrichedMessage));
  }

  sendMessage: SendMessage<MessageMeta> = async (message, transfer) => {
    const meta = message.meta as
      | (MessageMeta & { _transport?: 'runtime' | 'channel'; _channelSecret?: string })
      | undefined;
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
        this.ports.delete(secret);
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
          if (meta.tabId) {
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
    this.messageCallbacks.add(callback);
    return () => {
      this.messageCallbacks.delete(callback);
    };
  };

  /**
   * Get the number of active MessageChannel connections
   */
  getChannelConnectionCount(): number {
    return this.ports.size;
  }
}
