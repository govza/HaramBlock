import { logger, extractUrlId } from '@/utils/logger';

import type { TabEventListener } from '@/entrypoints/background/events/tabEventListener';
import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { IconService } from '@/entrypoints/background/services/iconService';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type { IHostSettings, IImagePrediction, IImageTransfer } from '@/utils/types';

type HostSettingsCallback = (hostname: string) => void;
type InferencePredictionsCallback = (data: { predictions: IImagePrediction[]; hostname: string }) => void;

/**
 * BackgroundRpc consolidates all controller functionality into one RPC service
 * Provided by background, consumed by content scripts and popup
 */
export class BackgroundRpc {
  // Subscription callbacks
  private hostSettingsCallbacks = new Map<string, HostSettingsCallback>();
  private inferencePredictionsCallbacks = new Map<string, InferencePredictionsCallback>();

  constructor(
    private hostSettingsService: HostSettingsService,
    private imageCacheService: ImageCacheService,
    private inferenceService: InferenceOrchestrationService,
    private iconService: IconService,
    private tabEventListener: TabEventListener,
  ) {}

  // ============ Request-Response Methods (replaces controllers) ============

  async getHostSettings(hostname: string): Promise<IHostSettings> {
    return this.hostSettingsService.getHostSettings(hostname);
  }

  async getCachedPredictions(hostname: string): Promise<IImagePrediction[]> {
    try {
      const predictions = await this.imageCacheService.getCachedPredictionsByHostname(hostname);
      if (predictions.length > 0) {
        logger.withTag('backgroundRpc').log(`Retrieved ${predictions.length} cached predictions for: ${hostname}`);
      }
      return predictions;
    } catch (error) {
      logger.withTag('backgroundRpc').error('Error retrieving cached predictions:', hostname, error);
      throw error;
    }
  }

  /**
   * Process image for inference.
   * Chrome: Receives ImageBitmap as transferable via MessageChannel (zero-copy)
   * Firefox: Receives Blob via browser.runtime (structured clone), converts to ImageBitmap
   *
   * Tab ID is resolved by querying tabs matching the hostname (comctx pattern).
   */
  async postInferenceImage(imageData: IImageTransfer): Promise<void> {
    const { hostname, src, width, height, metadata } = imageData;

    if (!hostname) {
      logger.withTag('backgroundRpc').error('Hostname is required for inference request');
      return;
    }

    logger.withTag('backgroundRpc').debug('postInferenceImage called', {
      kind: imageData?.kind,
      hostname,
    });

    // Resolve tab ID by querying tabs with matching hostname (comctx pattern)
    // Use cached active tab as fast path, fall back to querying by hostname
    let tabId = this.tabEventListener.getActiveTabId();
    if (!tabId) {
      const tabs = await browser.tabs.query({ url: `*://${hostname}/*` });
      tabId = tabs[0]?.id ?? null;
    }
    if (!tabId) {
      // Use placeholder - predictions are broadcast to all subscribers anyway
      logger.withTag('backgroundRpc').warn('Could not resolve tab ID, using default priority');
      tabId = -1;
    }

    logger
      .withTag('backgroundRpc')
      .log(`Inference request (${imageData.kind}) for ${extractUrlId(src)} from: ${hostname}`);

    try {
      const hostSettings = await this.hostSettingsService.getHostSettings(hostname);

      // Build inference input based on transfer kind
      if (imageData.kind === 'bitmap') {
        // Chrome: Use pre-loaded bitmap (zero-copy from MessageChannel)
        await this.inferenceService.scheduleInferenceTask({
          input: {
            kind: 'bitmap',
            imageSrc: src,
            bitmap: imageData.bitmap,
            originalWidth: width,
            originalHeight: height,
          },
          hostname,
          tabId,
          hostSettings,
          imageMetadata: metadata,
        });
      } else if (imageData.kind === 'blob') {
        // Legacy blob path: convert to bitmap
        const bitmap = await createImageBitmap(imageData.blob);
        await this.inferenceService.scheduleInferenceTask({
          input: { kind: 'bitmap', imageSrc: src, bitmap, originalWidth: width, originalHeight: height },
          hostname,
          tabId,
          hostSettings,
          imageMetadata: metadata,
        });
      } else {
        // Firefox URL path: let inference library fetch (uses browser cache, tracks timing)
        await this.inferenceService.scheduleInferenceTask({
          input: { kind: 'src', imageSrc: src },
          hostname,
          tabId,
          hostSettings,
          imageMetadata: metadata,
        });
      }
    } catch (error) {
      logger.withTag('backgroundRpc').error('Failed to schedule inference:', hostname, error);
    }
  }

  async updateIcon(hostname: string, tabId?: number): Promise<void> {
    if (!hostname) {
      throw new Error('Hostname is required for icon update');
    }

    try {
      if (tabId) {
        await this.iconService.updateIconForTab(tabId, hostname);
      } else {
        await this.iconService.updateIconForActiveTabWithHostname(hostname);
      }
    } catch (error) {
      logger.withTag('backgroundRpc').error('Error updating icon:', hostname, error);
      throw error;
    }
  }

  notifyHostSettingsChanged(hostname: string): void {
    this.emitHostSettingsUpdated(hostname);
  }

  // ============ Subscription Methods (replaces onMessage listeners) ============
  // Note: These return subscription IDs instead of functions because functions can't be
  // serialized over MessageChannel. Use the corresponding off* methods to unsubscribe.

  onHostSettingsUpdated(callback: HostSettingsCallback): string {
    const id = crypto.randomUUID();
    this.hostSettingsCallbacks.set(id, callback);
    return id;
  }

  offHostSettingsUpdated(subscriptionId: string): void {
    this.hostSettingsCallbacks.delete(subscriptionId);
  }

  onInferencePredictions(callback: InferencePredictionsCallback): string {
    const id = crypto.randomUUID();
    this.inferencePredictionsCallbacks.set(id, callback);
    return id;
  }

  offInferencePredictions(subscriptionId: string): void {
    this.inferencePredictionsCallbacks.delete(subscriptionId);
  }

  // ============ Emit Methods (called internally to push to subscribers) ============

  emitHostSettingsUpdated(hostname: string): void {
    this.hostSettingsCallbacks.forEach(callback => callback(hostname));
  }

  emitInferencePredictions(predictions: IImagePrediction[], hostname: string): void {
    this.inferencePredictionsCallbacks.forEach(callback => callback({ predictions, hostname }));
  }
}
