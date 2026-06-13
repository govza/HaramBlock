import { logger } from '@/utils/logger';
import { mergeContentEvent, storeWideEvent } from '@/utils/logging/eventStorage';
import { getLogSettings } from '@/utils/logging/logSettings';
import { getRpcContext } from '@/utils/messaging/rpcContext';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { IconService } from '@/entrypoints/background/services/iconService';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type { ModelService } from '@/entrypoints/background/services/modelService';
import type { WideEvent } from '@/utils/logging/types';
import type { ModelPreference } from '@/utils/modelSettings';
import type {
  ForcedVisibility,
  IHostSettings,
  IImagePrediction,
  IFramePrediction,
  IImageTransfer,
  IVideoFrameTransfer,
} from '@/utils/types';

type ImagePredictionsCallback = (data: { predictions: IImagePrediction[]; hostname: string }) => void;
type FramePredictionsCallback = (data: { predictions: IFramePrediction[]; hostname: string }) => void;
type ContextMenuToggleCallback = (data: { src: string; forcedVisibility: ForcedVisibility }) => void;

/**
 * BackgroundRpc consolidates all controller functionality into one RPC service
 * Provided by background, consumed by content scripts and popup
 */
export class BackgroundRpc {
  private imagePredictionsCallbacks = new Map<string, ImagePredictionsCallback>();
  private framePredictionsCallbacks = new Map<string, FramePredictionsCallback>();
  private contextMenuToggleCallbacks = new Map<string, ContextMenuToggleCallback>();

  constructor(
    private hostSettingsService: HostSettingsService,
    private imageCacheService: ImageCacheService,
    private inferenceService: InferenceOrchestrationService,
    private iconService: IconService,
    private modelService: ModelService,
  ) {}

  // ============ Request-Response Methods (replaces controllers) ============

  async getHostSettings(hostname: string, isIncognito = false): Promise<IHostSettings> {
    return this.hostSettingsService.getHostSettings(hostname, isIncognito);
  }

  async getCachedPredictions(hostname: string): Promise<IImagePrediction[]> {
    try {
      return await this.imageCacheService.getCachedPredictionsByHostname(hostname);
    } catch (error) {
      logger.withTag('backgroundRpc').error('Error retrieving cached predictions:', hostname, error);
      throw error;
    }
  }

  async updateToggleState(src: string, forcedVisibility: ForcedVisibility): Promise<void> {
    try {
      await this.imageCacheService.updateToggleState(src, forcedVisibility);
    } catch (error) {
      logger.withTag('backgroundRpc').error('Failed to update toggle state:', error);
      throw error;
    }
  }

  /**
   * Merge content timing into existing background event.
   * If no matching background event exists, store as separate event.
   */
  async storeContentEvent(event: WideEvent): Promise<void> {
    const merged = await mergeContentEvent(event);
    const settings = await getLogSettings();
    const shouldLog = settings.consoleEnabled || import.meta.env.DEV;

    if (merged) {
      // Log the merged event to console if enabled
      if (shouldLog) {
        const prefix = `[${merged.reqId}]`;
        const summary = `${merged.status} ${merged.hostname} +${merged.totalMs}ms`;
        // eslint-disable-next-line no-console
        console.log(prefix, summary, merged);
      }
    } else {
      // No matching background event found - store and log as standalone content event
      await storeWideEvent(event);
      if (shouldLog) {
        const prefix = `[${event.reqId}]`;
        const summary = `${event.status} ${event.hostname} +${event.totalMs}ms (content-only)`;
        // eslint-disable-next-line no-console
        console.log(prefix, summary, event);
      }
    }
  }

  /**
   * Process image for inference.
   * Chrome: Receives ImageBitmap as transferable via MessageChannel (zero-copy)
   * Firefox: Receives Blob via browser.runtime (structured clone), converts to ImageBitmap
   */
  async postInferenceImage(imageData: IImageTransfer): Promise<void> {
    const receivedAt = Date.now();
    const { hostname, src, width, height, metadata, priority } = imageData;

    if (!hostname) {
      logger.withTag('backgroundRpc').error('Hostname is required for inference request');
      return;
    }

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
            requestStartAt: imageData.requestStartAt,
            receivedAt,
            fetchTime: imageData.fetchTime,
            decodeTime: imageData.decodeTime,
          },
          hostname,
          hostSettings,
          mediaMetadata,
          priority,
        });
      } else if (imageData.kind === 'blob') {
        await this.inferenceService.scheduleInferenceTask({
          input: {
            kind: 'blob',
            imageSrc: src,
            blob: imageData.blob,
            originalWidth: width,
            originalHeight: height,
            requestStartAt: imageData.requestStartAt,
            receivedAt,
            fetchTime: imageData.fetchTime,
          },
          hostname,
          hostSettings,
          mediaMetadata,
          priority,
        });
      } else {
        await this.inferenceService.scheduleInferenceTask({
          input: { kind: 'src', imageSrc: src, requestStartAt: imageData.requestStartAt, receivedAt },
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

  async updateIconBadge(count: number, _url: string): Promise<void> {
    const { tabId } = getRpcContext();
    if (!tabId) return;
    await this.iconService.updateBadgeForTab(tabId, count);
  }

  async updateIcon(hostname: string): Promise<void> {
    // Read tabId synchronously before any await — set by CompositeProvideAdapter per request
    const { tabId } = getRpcContext();

    if (!hostname) {
      throw new Error('Hostname is required for icon update');
    }
    if (!tabId) {
      return;
    }

    try {
      await this.iconService.updateIconForTab(tabId, hostname);
    } catch (error) {
      logger.withTag('backgroundRpc').error('Error updating icon:', hostname, error);
      throw error;
    }
  }

  async getAvailableModels(timeoutMs = 2000, pollMs = 100): Promise<{ id: string; name: string; inputSize: number }[]> {
    return this.modelService.getAvailableModels(timeoutMs, pollMs);
  }

  getCurrentModelId(): Promise<string | null> {
    return Promise.resolve(this.modelService.getCurrentModelId());
  }

  async setCurrentModel(modelId: string) {
    await this.modelService.switchModel(modelId);
  }

  async setModelPreference(preference: ModelPreference): Promise<void> {
    await this.modelService.setModelPreference(preference);
  }

  getEffectiveModelId(): Promise<string> {
    return Promise.resolve(this.modelService.getCurrentModelId());
  }

  // ============ Subscription Methods (replaces onMessage listeners) ============
  // Note: These return subscription IDs instead of functions because functions can't be
  // serialized over MessageChannel. Use the corresponding off* methods to unsubscribe.

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

  onContextMenuToggle(callback: ContextMenuToggleCallback): string {
    const id = crypto.randomUUID();
    this.contextMenuToggleCallbacks.set(id, callback);
    return id;
  }

  offContextMenuToggle(subscriptionId: string): void {
    this.contextMenuToggleCallbacks.delete(subscriptionId);
  }

  // ============ Emit Methods ============

  emitImagePredictions(predictions: IImagePrediction[], hostname: string): void {
    this.imagePredictionsCallbacks.forEach(callback => callback({ predictions, hostname }));
  }

  emitFramePredictions(predictions: IFramePrediction[], hostname: string): void {
    this.framePredictionsCallbacks.forEach(callback => callback({ predictions, hostname }));
  }

  emitContextMenuToggle(src: string, forcedVisibility: ForcedVisibility): void {
    this.contextMenuToggleCallbacks.forEach(callback => callback({ src, forcedVisibility }));
  }
}
