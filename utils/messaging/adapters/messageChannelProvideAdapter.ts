import { logger } from '@/utils/logger';

import type { MessageMeta } from '@/utils/messaging/adapters/browserRuntimeAdapter';
import type { Adapter, Message, SendMessage, OnMessage } from 'comctx';

interface PortInfo {
  port: MessagePort;
  secret: string;
  tabId?: number;
}

/**
 * MessageChannelProvideAdapter implements comctx Adapter interface for the background service worker.
 * It handles MessageChannel connections from content scripts and routes messages accordingly.
 *
 * This adapter listens for PORT_READY messages from injected iframes, stores the ports,
 * and forwards comctx protocol messages between content scripts and the background.
 */
export class MessageChannelProvideAdapter implements Adapter<MessageMeta> {
  private ports = new Map<string, PortInfo>();
  private messageCallbacks = new Set<(message?: Partial<Message<MessageMeta>>) => void>();
  private initialized = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Listen for PORT_READY messages from injected iframes
    globalThis.addEventListener('message', this.handleGlobalMessage);
    logger.withTag('MessageChannelProvideAdapter').log('Initialized, listening for PORT_READY');
  }

  private handleGlobalMessage = (event: Event): void => {
    const evt = event as MessageEvent;
    const data = evt.data as { type?: string; secret?: string } | undefined;

    if (!data || data.type !== 'PORT_READY') return;

    const secret = data.secret || '';
    const ports = evt.ports || [];
    const port = ports[0];

    if (!secret || !port) {
      logger.withTag('MessageChannelProvideAdapter').warn('Missing secret or port on PORT_READY');
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
      logger.withTag('MessageChannelProvideAdapter').error('Port message error, removing:', secret);
      this.ports.delete(secret);
    };

    // ACK to content script
    try {
      port.postMessage({ type: 'READY' });
      logger.withTag('MessageChannelProvideAdapter').log('Port established for secret:', secret);
    } catch (error) {
      logger.withTag('MessageChannelProvideAdapter').error('Failed to ACK on port:', error);
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
        // Store secret for routing responses back
        _channelSecret: secret,
        // Use URL from meta if available
        url: data.meta?.url || '',
        tabId: data.meta?.tabId,
      } as MessageMeta & { _channelSecret: string },
    };

    // Forward to all registered callbacks
    this.messageCallbacks.forEach(callback => callback(enrichedMessage));
  }

  sendMessage: SendMessage<MessageMeta> = (message, transfer) => {
    const meta = message.meta as (MessageMeta & { _channelSecret?: string }) | undefined;
    const secret = meta?._channelSecret;

    if (!secret) {
      // No secret means we can't route via MessageChannel
      // This might be a broadcast or the message didn't come from MessageChannel
      logger.withTag('MessageChannelProvideAdapter').warn('No channel secret in message meta, cannot route');
      return;
    }

    const portInfo = this.ports.get(secret);
    if (!portInfo) {
      logger.withTag('MessageChannelProvideAdapter').warn('Port not found for secret:', secret);
      return;
    }

    try {
      // Clean the message meta before sending (remove internal routing fields)
      const cleanMessage = {
        ...message,
        meta: {
          ...message.meta,
          _channelSecret: undefined,
        },
      };

      if (transfer.length > 0) {
        portInfo.port.postMessage(cleanMessage, transfer);
      } else {
        portInfo.port.postMessage(cleanMessage);
      }
    } catch (error) {
      logger.withTag('MessageChannelProvideAdapter').error('Failed to send message:', error);
      // Port might be dead, clean it up
      this.ports.delete(secret);
    }
  };

  onMessage: OnMessage<MessageMeta> = callback => {
    this.messageCallbacks.add(callback);
    return () => {
      this.messageCallbacks.delete(callback);
    };
  };

  /**
   * Get the number of active connections
   */
  getConnectionCount(): number {
    return this.ports.size;
  }

  /**
   * Clean up a specific connection by secret
   */
  removeConnection(secret: string): void {
    this.ports.delete(secret);
  }

  /**
   * Clean up all connections
   */
  cleanup(): void {
    this.ports.clear();
    globalThis.removeEventListener('message', this.handleGlobalMessage);
  }
}
