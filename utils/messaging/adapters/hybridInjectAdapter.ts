import { USE_MESSAGE_CHANNEL } from '@/utils/constants';
import { logger } from '@/utils/logger';
import { InjectAdapter, type MessageMeta } from '@/utils/messaging/adapters/browserRuntimeAdapter';
import { MessageChannelInjectAdapter } from '@/utils/messaging/adapters/messageChannelAdapter';

import type { Adapter, Message, SendMessage, OnMessage } from 'comctx';

/**
 * HybridInjectAdapter routes RPC calls based on transferable requirements:
 * - Chrome + has transferables (ImageBitmap) → MessageChannel (zero-copy)
 * - Chrome + no transferables → browser.runtime
 * - Firefox → always browser.runtime (structured clone handles blobs/bitmaps)
 */
type MessageCallback = (message?: Partial<Message<MessageMeta>>) => void;
type CleanupFn = ReturnType<OnMessage<MessageMeta>>;

export class HybridInjectAdapter implements Adapter<MessageMeta> {
  private runtimeAdapter: InjectAdapter;
  private channelAdapter: MessageChannelInjectAdapter | null = null;
  private pendingChannelCallbacks = new Set<MessageCallback>();
  private channelCleanups = new Map<MessageCallback, CleanupFn>();

  constructor() {
    this.runtimeAdapter = new InjectAdapter('content');
  }

  private getChannelAdapter(): MessageChannelInjectAdapter | null {
    if (!USE_MESSAGE_CHANNEL) return null;
    if (!this.channelAdapter) {
      this.channelAdapter = new MessageChannelInjectAdapter();
      for (const cb of this.pendingChannelCallbacks) {
        this.channelCleanups.set(cb, this.channelAdapter.onMessage(cb));
      }
      this.pendingChannelCallbacks.clear();
    }
    return this.channelAdapter;
  }

  isChannelAvailable(): boolean {
    return this.channelAdapter?.isAvailable() ?? false;
  }

  async waitForChannel(): Promise<boolean> {
    const adapter = this.getChannelAdapter();
    if (!adapter) return false;
    return adapter.waitForReady();
  }

  warmupChannel(): void {
    this.getChannelAdapter();
  }

  sendMessage: SendMessage<MessageMeta> = async (message, transfer) => {
    const hasTransferables = transfer && transfer.length > 0;
    const channelAdapter = hasTransferables ? this.getChannelAdapter() : null;

    if (USE_MESSAGE_CHANNEL && hasTransferables && channelAdapter) {
      if (!channelAdapter.isAvailable()) {
        logger.withTag('HybridInjectAdapter').debug('Waiting for MessageChannel to be ready...');
        const ready = await channelAdapter.waitForReady();
        if (!ready) {
          logger.withTag('HybridInjectAdapter').error('MessageChannel not available, cannot send transferables');
          throw new Error('MessageChannel not available for transferable data');
        }
      }
      logger.withTag('HybridInjectAdapter').debug(`Routing via MessageChannel (${transfer.length} transferables)`);
      return channelAdapter.sendMessage(message, transfer);
    }

    return this.runtimeAdapter.sendMessage(message, transfer);
  };

  onMessage: OnMessage<MessageMeta> = callback => {
    const runtimeCleanup = this.runtimeAdapter.onMessage(callback);

    if (this.channelAdapter) {
      this.channelCleanups.set(callback, this.channelAdapter.onMessage(callback));
    } else if (USE_MESSAGE_CHANNEL) {
      this.pendingChannelCallbacks.add(callback);
    }

    return () => {
      if (typeof runtimeCleanup === 'function') {
        void runtimeCleanup();
      }
      const channelCleanup = this.channelCleanups.get(callback);
      if (typeof channelCleanup === 'function') {
        void channelCleanup();
      }
      this.channelCleanups.delete(callback);
      this.pendingChannelCallbacks.delete(callback);
    };
  };
}
