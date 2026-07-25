import { injectBackgroundRpc, HybridInjectAdapter } from '@/utils/messaging';

/**
 * Singleton BackgroundRpc proxy for content scripts.
 *
 * Uses HybridInjectAdapter which routes messages based on transferable requirements:
 * - Chrome + has transferables (ImageBitmap) → MessageChannel
 * - Chrome + no transferables → browser.runtime
 * - Firefox → always browser.runtime (structured clone handles blobs/bitmaps)
 *
 * URL is included in meta for all messages (via adapters), allowing background
 * to query tabs by URL when needed - following the comctx pattern.
 */
const hybridAdapter = new HybridInjectAdapter();
export const backgroundRpc = injectBackgroundRpc(hybridAdapter);

/**
 * Check if MessageChannel is available for transferables.
 * Used by sender to decide between bitmap and url transfer kinds.
 */
export function isMessageChannelAvailable(): boolean {
  return hybridAdapter.isChannelAvailable();
}

/**
 * Wait for MessageChannel to be ready (with timeout).
 * Returns true if ready, false if timeout.
 */
export function waitForMessageChannel(): Promise<boolean> {
  return hybridAdapter.waitForChannel();
}

/**
 * Eagerly start the MessageChannel handshake.
 * Call from content script main() after content-type filtering
 * so PDF/XML pages skip it while normal pages prewarm the channel.
 */
export function warmupMessageChannel(): void {
  hybridAdapter.warmupChannel();
}

/**
 * Subscribe to permanent MessageChannel death: channel establishment failed
 * because the extension context is invalidated (reload, update, disable,
 * removal). The instance lifecycle uses this to fail open when no successor
 * ever stamps the supersede sentinel. Returns an unsubscribe function.
 */
export function onMessageChannelPermanentDeath(callback: () => void): () => void {
  return hybridAdapter.onChannelPermanentDeath(callback);
}
