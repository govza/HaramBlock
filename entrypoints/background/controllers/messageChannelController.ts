import { logger } from '@/utils/logger';
import {
  isChannelRequest,
  type ChannelRequest,
  type ChannelResponse,
  type ChannelReady,
} from '@/utils/messaging/channelTypes';

/**
 * Handles establishing a direct messageChannelController tunnel from content via an injected
 * web-accessible page to the background service worker.
 *
 * Iframe script posts: `{ type: 'PORT_READY', secret }` with a transferred MessagePort.
 * We ACK immediately so the content side resolves its readiness await.
 */
export class MessageChannelController {
  private readonly ports = new Map<string, MessagePort>();

  public initialize(): void {
    // Listen for messages sent to the service worker global (from the injected page)
    globalThis.addEventListener('message', this.handleMessageEventAdapter);
  }

  private handleMessageEventAdapter = (evt: Event): void => {
    this.handleMessageEvent(evt as MessageEvent);
  };

  private handleMessageEvent = (evt: MessageEvent): void => {
    const data = (evt as MessageEvent & { data?: unknown; ports?: MessagePort[] }).data as
      | { type?: string; secret?: string }
      | undefined;
    if (!data || !('type' in data)) return;

    if (data.type === 'PORT_READY') {
      const secret = data.secret || '';
      const ports = (evt as MessageEvent & { ports?: MessagePort[] }).ports || [];
      const port = ports[0];

      if (!secret || !port) {
        logger.withTag('messageChannelController').warn('Missing secret or port on PORT_READY');
        return;
      }

      // Keep a reference by secret; callers may route by tab later if needed
      this.ports.set(secret, port);

      // Wire port lifecycle + inbound messages
      port.onmessage = this.handlePortMessage.bind(this, secret);
      port.onmessageerror = () => {
        logger.withTag('messageChannelController').error('Port message error; closing tunnel for secret:', secret);
        this.ports.delete(secret);
      };

      // ACK once so content resolves readiness
      try {
        const ready: ChannelReady = { type: 'READY' };
        port.postMessage(ready);
      } catch (e) {
        logger.withTag('messageChannelController').error('Failed to ACK on port:', e);
      }

      logger.withTag('messageChannelController').log('Port established for secret:', secret);
    }
  };

  private handlePortMessage = (secret: string, ev: MessageEvent<unknown>): void => {
    const { data } = ev;

    if (isChannelRequest(data)) {
      this.handleRequest(secret, data);
      return;
    }

    // For now, just log non-request messages
    logger.withTag('messageChannelController').log('Received non-request message (secret=', secret, '):', data);
  };

  private handleRequest(secret: string, req: ChannelRequest): void {
    // Minimal demo routing; extend with real actions (e.g., inference)
    switch (req.action) {
      default: {
        const res: ChannelResponse<string, never> = {
          id: req.id,
          type: 'response',
          action: `${req.action}-result`,
          success: false,
          error: `Unknown action: ${req.action}`,
        };
        this.send(secret, res);
      }
    }
  }

  /**
   * Send a message over the tunnel identified by `secret`.
   */
  public send(secret: string, message: unknown, transfer?: Transferable[]): boolean {
    const port = this.ports.get(secret);
    if (!port) return false;
    try {
      if (transfer && transfer.length > 0) {
        port.postMessage(message, transfer);
      } else {
        port.postMessage(message);
      }
      return true;
    } catch (e) {
      logger.withTag('messageChannelController').error('Failed to send on port (secret=', secret, '):', e);
      return false;
    }
  }
}
