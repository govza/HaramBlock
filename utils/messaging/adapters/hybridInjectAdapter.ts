import { USE_MESSAGE_CHANNEL } from '@/utils/constants';
import { logger } from '@/utils/logger';
import { InjectAdapter, type MessageMeta } from '@/utils/messaging/adapters/browserRuntimeAdapter';
import { MessageChannelInjectAdapter } from '@/utils/messaging/adapters/messageChannelAdapter';

import type { Adapter, SendMessage, OnMessage } from 'comctx';

/**
 * HybridInjectAdapter routes RPC calls based on transferable requirements:
 * - Chrome + has transferables (ImageBitmap) → MessageChannel (zero-copy)
 * - Chrome + no transferables → browser.runtime
 * - Firefox → always browser.runtime (structured clone handles blobs/bitmaps)
 */
export class HybridInjectAdapter implements Adapter<MessageMeta> {
  private runtimeAdapter: InjectAdapter;
  private channelAdapter: MessageChannelInjectAdapter | null;

  constructor() {
    this.runtimeAdapter = new InjectAdapter('content');
    // Only create MessageChannel adapter on Chrome
    this.channelAdapter = USE_MESSAGE_CHANNEL ? new MessageChannelInjectAdapter() : null;
  }

  /**
   * Check if MessageChannel is currently available for transferables.
   */
  isChannelAvailable(): boolean {
    return this.channelAdapter?.isAvailable() ?? false;
  }

  /**
   * Wait for MessageChannel to be ready (with timeout).
   * Returns true if ready, false if timeout or not supported.
   */
  async waitForChannel(): Promise<boolean> {
    if (!this.channelAdapter) return false;
    return this.channelAdapter.waitForReady();
  }

  sendMessage: SendMessage<MessageMeta> = async (message, transfer) => {
    const hasTransferables = transfer && transfer.length > 0;

    if (USE_MESSAGE_CHANNEL && hasTransferables && this.channelAdapter) {
      // Chrome with transferables: MUST use MessageChannel (ImageBitmap can't be sent via runtime)
      // Wait for channel if not ready yet - runtime fallback would cause DataCloneError
      if (!this.channelAdapter.isAvailable()) {
        logger.withTag('HybridInjectAdapter').debug('Waiting for MessageChannel to be ready...');
        const ready = await this.channelAdapter.waitForReady();
        if (!ready) {
          logger.withTag('HybridInjectAdapter').error('MessageChannel not available, cannot send transferables');
          throw new Error('MessageChannel not available for transferable data');
        }
      }
      logger.withTag('HybridInjectAdapter').debug(`Routing via MessageChannel (${transfer.length} transferables)`);
      return this.channelAdapter.sendMessage(message, transfer);
    }

    // Firefox or no transferables → browser.runtime
    return this.runtimeAdapter.sendMessage(message, transfer);
  };

  onMessage: OnMessage<MessageMeta> = callback => {
    // Listen on both adapters and forward to the callback
    const runtimeCleanup = this.runtimeAdapter.onMessage(callback);
    const channelCleanup = this.channelAdapter?.onMessage(callback);

    return () => {
      if (typeof runtimeCleanup === 'function') {
        void runtimeCleanup();
      }
      if (typeof channelCleanup === 'function') {
        void channelCleanup();
      }
    };
  };
}
