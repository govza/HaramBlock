import { isExtensionContextValid } from '@/utils/extensionContext';
import { logger } from '@/utils/logger';

import type { MessageMeta } from '@/utils/messaging/adapters/browserRuntimeAdapter';
import type { Adapter, Message, SendMessage, OnMessage } from 'comctx';

/**
 * MessageChannelAdapter implements comctx Adapter interface using MessageChannel transport.
 * This enables sending transferables (ImageBitmap, ArrayBuffer) between content script and
 * background service worker without serialization overhead.
 *
 * Flow:
 * 1. Content script creates iframe loading web-accessible page
 * 2. Content posts MessageChannel.port2 to iframe
 * 3. Iframe forwards port to service worker via navigator.serviceWorker.ready
 * 4. Service worker ACKs with { type: 'READY' }
 * 5. Content uses port1 for all subsequent messages with transferables
 */
export class MessageChannelInjectAdapter implements Adapter<MessageMeta> {
  private port: MessagePort | null = null;
  private channelPromise: Promise<MessagePort> | null = null;
  private messageCallbacks = new Set<(message?: Partial<Message<MessageMeta>>) => void>();
  private deathCallbacks = new Set<() => void>();
  private isReady = false;

  constructor() {
    // Start initialization immediately (non-blocking)
    void this.initialize();
  }

  private resetState(): void {
    this.channelPromise = null;
    this.port = null;
    this.isReady = false;
  }

  /**
   * Establishment failed. With a live context this is transient (the next send
   * re-initializes); with an invalidated context (extension reloaded, updated,
   * disabled, or removed) the channel is permanently dead — report it so the
   * instance lifecycle can fail open.
   */
  private handleEstablishFailure(): void {
    this.resetState();
    if (isExtensionContextValid()) return;
    logger.withTag('MessageChannelInjectAdapter').warn('Channel establishment failed: extension context invalidated');
    this.deathCallbacks.forEach(callback => callback());
  }

  private async initialize(): Promise<void> {
    if (this.channelPromise) {
      return; // Already initializing
    }

    try {
      this.channelPromise = this.establishChannel();

      // Race with timeout for quick availability check
      const timeoutPromise = new Promise<'timeout'>(resolve => {
        setTimeout(() => resolve('timeout'), 5000);
      });

      const result = await Promise.race([
        this.channelPromise.then(port => ({ type: 'port' as const, port })),
        timeoutPromise.then(t => ({ type: t })),
      ]);

      if (result.type === 'port') {
        this.port = result.port;
        this.isReady = true;
        logger.withTag('MessageChannelInjectAdapter').debug('Channel established');
      } else {
        // Timeout - but keep waiting in background (don't discard the promise)
        logger.withTag('MessageChannelInjectAdapter').warn('Channel timeout, continuing in background...');
        this.channelPromise
          .then(port => {
            this.port = port;
            this.isReady = true;
            logger.withTag('MessageChannelInjectAdapter').debug('Channel established (late)');
          })
          .catch(() => {
            this.handleEstablishFailure();
          });
      }
    } catch {
      this.handleEstablishFailure();
    }
  }

  private async establishChannel(): Promise<MessagePort> {
    // Wake the service worker before iframe creation so navigator.serviceWorker.ready
    // resolves quickly inside the iframe. Without this, a dormant SW can cause the
    // iframe's ready promise to hang on slow machines.
    await browser.runtime.sendMessage({ type: '__ping__' }).catch(() => {});

    const secret = crypto.randomUUID();
    const url = new URL(browser.runtime.getURL('/message-channel.html'));
    url.searchParams.set('secret', secret);

    // Create hidden iframe in shadow DOM
    const container = document.createElement('div');
    const root = container.attachShadow({ mode: 'closed' });
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    root.appendChild(iframe);
    (document.body || document.documentElement).appendChild(container);

    // Wait for iframe to load
    await new Promise<void>((resolve, reject) => {
      iframe.onload = () => resolve();
      iframe.onerror = reject;
      iframe.src = url.toString();
    });

    // Create MessageChannel and transfer port2 to iframe
    const mc = new MessageChannel();
    iframe.contentWindow?.postMessage(secret, url.origin, [mc.port2]);

    // Wait for service worker to ACK with READY (with timeout)
    const readyReceived = await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => {
        logger.withTag('MessageChannelInjectAdapter').error('Timeout waiting for READY ACK from service worker');
        resolve(false);
      }, 10000); // 10s timeout for SW ACK

      mc.port1.addEventListener(
        'message',
        (event: MessageEvent<{ type?: string }>) => {
          if (event.data?.type === 'READY') {
            clearTimeout(timeout);
            resolve(true);
          }
        },
        { once: true },
      );
      // Manually start the port since we're using addEventListener
      mc.port1.start();
    });

    if (!readyReceived) {
      // Clean up iframe
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
      throw new Error('Service worker did not ACK MessageChannel');
    }

    // Tell the background which tab owns this channel so it can release the port when the
    // tab closes or reloads. Runtime messages carry sender.tab.id; the channel itself does not.
    browser.runtime.sendMessage({ type: 'REGISTER_CHANNEL_TAB', secret }).catch(() => {});

    // Wire up message handler for comctx messages
    mc.port1.onmessage = (event: MessageEvent<Partial<Message<MessageMeta>> | undefined>) => {
      // Forward to all registered callbacks
      this.messageCallbacks.forEach(callback => callback(event.data));
    };

    // When the service worker is terminated (MV3 idle timeout), its end of the
    // channel is disentangled and messages posted here vanish with no error.
    // The port close event is the only signal: mark the channel dead so the
    // next send re-establishes it instead of posting into the void. Rebuilding
    // lazily (not here) avoids a wake/idle keepalive loop while the page is
    // quiet. (No-op on engines without the close event.)
    mc.port1.addEventListener('close', () => {
      logger.withTag('MessageChannelInjectAdapter').warn('Channel port closed; will re-establish on next send');
      this.resetState();
    });

    // Clean up iframe
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }

    return mc.port1;
  }

  private doSend(message: Message<MessageMeta>, transfer: Transferable[]): void {
    if (!this.port) return;

    try {
      if (transfer.length > 0) {
        this.port.postMessage(message, transfer);
      } else {
        this.port.postMessage(message);
      }
    } catch (error) {
      logger.withTag('MessageChannelInjectAdapter').error('Failed to send message:', error);
    }
  }

  sendMessage: SendMessage<MessageMeta> = (message, transfer) => {
    // Enrich message with metadata
    const enrichedMessage = {
      ...message,
      meta: { ...message.meta, url: document.location.href, injector: 'content' as const },
    };

    if (this.isReady && this.port) {
      this.doSend(enrichedMessage, transfer);
    } else {
      logger.withTag('MessageChannelInjectAdapter').error('Channel not available');
      // The message is lost (callers time out and retry); make sure a channel
      // is being (re-)established for the retry to land on.
      void this.initialize();
    }
  };

  onMessage: OnMessage<MessageMeta> = callback => {
    this.messageCallbacks.add(callback);
    return () => {
      this.messageCallbacks.delete(callback);
    };
  };

  /**
   * Subscribe to permanent channel death (invalidated extension context).
   * Not fired by the service-worker idle kill, which only closes the port and
   * re-establishes lazily on the next send.
   */
  onPermanentDeath(callback: () => void): void {
    this.deathCallbacks.add(callback);
  }

  /**
   * Check if the MessageChannel is available and ready
   */
  isAvailable(): boolean {
    return this.isReady && this.port !== null;
  }

  /**
   * Wait for the channel to be ready with a hard timeout.
   * Returns false if channel fails or times out (caller should handle gracefully).
   */
  async waitForReady(): Promise<boolean> {
    if (this.isAvailable()) {
      return true;
    }

    // Ensure initialization has started
    if (!this.channelPromise) {
      void this.initialize();
    }

    // Wait for the actual channel promise with a hard timeout
    if (this.channelPromise) {
      try {
        const timeoutPromise = new Promise<'timeout'>(resolve => {
          setTimeout(() => resolve('timeout'), 15000); // 15s hard timeout
        });

        const result = await Promise.race([
          this.channelPromise.then(port => ({ type: 'port' as const, port })),
          timeoutPromise.then(t => ({ type: t })),
        ]);

        if (result.type === 'port') {
          this.port = result.port;
          this.isReady = true;
          return true;
        }

        logger.withTag('MessageChannelInjectAdapter').error('Hard timeout waiting for channel');
        return false;
      } catch {
        this.handleEstablishFailure();
        return false;
      }
    }

    return false;
  }
}
