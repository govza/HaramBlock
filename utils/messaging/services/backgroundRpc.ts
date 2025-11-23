import { logger, extractUrlId } from '@/utils/logger';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { IconService } from '@/entrypoints/background/services/iconService';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type { IHostSettings, IImagePrediction, IImageWithMetadata } from '@/utils/types';

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

  async postInferenceImage(hostname: string, tabId: number, imageData: IImageWithMetadata): Promise<void> {
    if (!hostname) {
      logger.withTag('backgroundRpc').error('Hostname is required for inference request');
      return;
    }

    if (!tabId) {
      logger.withTag('backgroundRpc').error('Tab ID is required to send results back');
      return;
    }

    logger.withTag('backgroundRpc').log(`Inference request for ${extractUrlId(imageData.src)} from: ${hostname}`);

    try {
      const hostSettings = await this.hostSettingsService.getHostSettings(hostname);
      await this.inferenceService.scheduleInferenceTask({
        input: { kind: 'src', imageSrc: imageData.src },
        hostname,
        tabId,
        hostSettings,
        imageMetadata: imageData.metadata,
      });
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

  onHostSettingsUpdated(callback: HostSettingsCallback): () => void {
    const id = crypto.randomUUID();
    this.hostSettingsCallbacks.set(id, callback);
    return () => {
      this.hostSettingsCallbacks.delete(id);
    };
  }

  onInferencePredictions(callback: InferencePredictionsCallback): () => void {
    const id = crypto.randomUUID();
    this.inferencePredictionsCallbacks.set(id, callback);
    return () => {
      this.inferencePredictionsCallbacks.delete(id);
    };
  }

  // ============ Emit Methods (called internally to push to subscribers) ============

  emitHostSettingsUpdated(hostname: string): void {
    this.hostSettingsCallbacks.forEach(callback => callback(hostname));
  }

  emitInferencePredictions(predictions: IImagePrediction[], hostname: string): void {
    this.inferencePredictionsCallbacks.forEach(callback => callback({ predictions, hostname }));
  }
}
