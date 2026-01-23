import { logger } from '@/utils/logger';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { IconService } from '@/entrypoints/background/services/iconService';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type {
  IHostSettings,
  IImagePrediction,
  IFramePrediction,
  IImageTransfer,
  IVideoFrameTransfer,
} from '@/utils/types';

type HostSettingsCallback = (hostname: string) => void;
type ImagePredictionsCallback = (data: { predictions: IImagePrediction[]; hostname: string }) => void;
type FramePredictionsCallback = (data: { predictions: IFramePrediction[]; hostname: string }) => void;

/**
 * BackgroundRpc consolidates all controller functionality into one RPC service
 * Provided by background, consumed by content scripts and popup
 */
export class BackgroundRpc {
  private hostSettingsCallbacks = new Map<string, HostSettingsCallback>();
  private imagePredictionsCallbacks = new Map<string, ImagePredictionsCallback>();
  private framePredictionsCallbacks = new Map<string, FramePredictionsCallback>();

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

  async updateToggleState(src: string, forcedVisibility: 'visible' | 'blocked' | null): Promise<void> {
    try {
      await this.imageCacheService.updateToggleState(src, forcedVisibility);
      logger.withTag('backgroundRpc').debug(`Updated toggle state for ${src}: ${forcedVisibility}`);
    } catch (error) {
      logger.withTag('backgroundRpc').error('Failed to update toggle state:', error);
      throw error;
    }
  }

  /**
   * Process image for inference.
   * Chrome: Receives ImageBitmap as transferable via MessageChannel (zero-copy)
   * Firefox: Receives Blob via browser.runtime (structured clone), converts to ImageBitmap
   */
  async postInferenceImage(imageData: IImageTransfer): Promise<void> {
    const { hostname, src, width, height, metadata, priority } = imageData;

    if (!hostname) {
      logger.withTag('backgroundRpc').error('Hostname is required for inference request');
      return;
    }

    logger.withTag('backgroundRpc').debug('postInferenceImage called', {
      kind: imageData?.kind,
      hostname,
    });

    logger.withTag('backgroundRpc').log(`Inference request (${imageData.kind}) for ${src} from: ${hostname}`);

    try {
      const hostSettings = await this.hostSettingsService.getHostSettings(hostname);
      const mediaMetadata = { ...metadata, kind: 'image' as const };

      if (imageData.kind === 'bitmap') {
        await this.inferenceService.scheduleInferenceTask({
          input: {
            kind: 'bitmap',
            imageSrc: src,
            bitmap: imageData.bitmap,
            originalWidth: width,
            originalHeight: height,
          },
          hostname,
          hostSettings,
          mediaMetadata,
          priority,
        });
      } else if (imageData.kind === 'blob') {
        const bitmap = await createImageBitmap(imageData.blob);
        await this.inferenceService.scheduleInferenceTask({
          input: { kind: 'bitmap', imageSrc: src, bitmap, originalWidth: width, originalHeight: height },
          hostname,
          hostSettings,
          mediaMetadata,
          priority,
        });
      } else {
        await this.inferenceService.scheduleInferenceTask({
          input: { kind: 'src', imageSrc: src },
          hostname,
          hostSettings,
          mediaMetadata,
          priority,
        });
      }
    } catch (error) {
      logger.withTag('backgroundRpc').error('Failed to schedule inference:', hostname, error);
    }
  }

  /**
   * Process video frame for inference.
   * Chrome: Receives ImageBitmap as transferable via MessageChannel (zero-copy)
   * Firefox: Receives compressed WebP Blob via browser.runtime (structured clone)
   */
  async postInferenceVideoFrame(frameData: IVideoFrameTransfer): Promise<void> {
    const { hostname, videoUrl, frameIndex, timestampSec, originalWidth, originalHeight, priority } = frameData;

    if (!hostname) {
      logger.withTag('backgroundRpc').error('Hostname is required for video frame inference request');
      return;
    }

    const frameLabel = frameIndex === -1 ? 'thumbnail' : `frame ${frameIndex}`;
    logger.withTag('backgroundRpc').debug(`postInferenceVideoFrame: ${frameLabel}`, {
      kind: frameData.kind,
      hostname,
      videoUrl,
      timestampSec,
    });

    try {
      const hostSettings = await this.hostSettingsService.getHostSettings(hostname);

      const input =
        frameData.kind === 'bitmap'
          ? { kind: 'bitmap' as const, imageSrc: videoUrl, bitmap: frameData.bitmap, originalWidth, originalHeight }
          : { kind: 'blob' as const, imageSrc: videoUrl, blob: frameData.blob, originalWidth, originalHeight };

      await this.inferenceService.scheduleInferenceTask({
        input,
        hostname,
        hostSettings,
        mediaMetadata: {
          kind: 'frame',
          videoUrl,
          frameIndex,
          sessionId: frameData.sessionId,
          timestampSec,
        },
        priority,
      });
    } catch (error) {
      logger.withTag('backgroundRpc').error('Failed to schedule video frame inference:', hostname, error);
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

  onImagePredictions(callback: ImagePredictionsCallback): string {
    const id = crypto.randomUUID();
    this.imagePredictionsCallbacks.set(id, callback);
    return id;
  }

  offImagePredictions(subscriptionId: string): void {
    this.imagePredictionsCallbacks.delete(subscriptionId);
  }

  onFramePredictions(callback: FramePredictionsCallback): string {
    const id = crypto.randomUUID();
    this.framePredictionsCallbacks.set(id, callback);
    return id;
  }

  offFramePredictions(subscriptionId: string): void {
    this.framePredictionsCallbacks.delete(subscriptionId);
  }

  // ============ Emit Methods ============

  emitHostSettingsUpdated(hostname: string): void {
    this.hostSettingsCallbacks.forEach(callback => callback(hostname));
  }

  emitImagePredictions(predictions: IImagePrediction[], hostname: string): void {
    this.imagePredictionsCallbacks.forEach(callback => callback({ predictions, hostname }));
  }

  emitFramePredictions(predictions: IFramePrediction[], hostname: string): void {
    this.framePredictionsCallbacks.forEach(callback => callback({ predictions, hostname }));
  }
}
