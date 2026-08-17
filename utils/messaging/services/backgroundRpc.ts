import { logger } from '@/utils/logger';
import { mergeContentEvent, storeWideEvent } from '@/utils/logging/eventStorage';
import { getLogSettings } from '@/utils/logging/logSettings';
import { getRpcContext } from '@/utils/messaging/rpcContext';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { IconService } from '@/entrypoints/background/services/iconService';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type { MediaFetchService } from '@/entrypoints/background/services/mediaFetchService';
import type { ModelService } from '@/entrypoints/background/services/modelService';
import type { LatencySnapshot } from '@/utils/inference/shared/latencyTracker';
import type { WideEvent } from '@/utils/logging/types';
import type { ModelPreference } from '@/utils/modelSettings';
import type {
  ForcedVisibility,
  IHostSettings,
  IImagePrediction,
  IImageTransfer,
  IVideoFrameTransfer,
  IGifFrameTransfer,
  FrameInferenceResult,
  GifFrameInferenceResult,
  ImageInferenceResult,
} from '@/utils/types';

const BASE64_CHUNK_BYTES = 0x8000;

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

type ImagePredictionsCallback = (data: { results: ImageInferenceResult[]; hostname: string }) => void;
type FramePredictionsCallback = (data: { results: FrameInferenceResult[]; hostname: string }) => void;
type GifFramePredictionsCallback = (data: { results: GifFrameInferenceResult[]; hostname: string }) => void;
type ContextMenuToggleCallback = (data: { src: string; forcedVisibility: ForcedVisibility }) => void;

/**
 * Subscription entry tagged with the owning tab/frame (from the RPC context of
 * the subscribe call) so background-side entries can be reaped when the frame
 * goes away without an explicit unsubscribe - content scripts skip unload
 * cleanup on purpose, so untagged entries accumulate for the background's
 * lifetime and each one costs a full prediction fan-out per frame sample.
 */
interface Subscription<T> {
  callback: T;
  tabId?: number;
  frameId?: number;
}

/**
 * BackgroundRpc consolidates all controller functionality into one RPC service
 * Provided by background, consumed by content scripts and popup
 */
export class BackgroundRpc {
  private imagePredictionsCallbacks = new Map<string, Subscription<ImagePredictionsCallback>>();
  private framePredictionsCallbacks = new Map<string, Subscription<FramePredictionsCallback>>();
  private gifFramePredictionsCallbacks = new Map<string, Subscription<GifFramePredictionsCallback>>();
  private contextMenuToggleCallbacks = new Map<string, Subscription<ContextMenuToggleCallback>>();

  private get subscriptionMaps(): Map<string, Subscription<unknown>>[] {
    return [
      this.imagePredictionsCallbacks,
      this.framePredictionsCallbacks,
      this.gifFramePredictionsCallbacks,
      this.contextMenuToggleCallbacks,
    ];
  }

  /**
   * Register a callback keyed by the calling tab/frame. A frame re-subscribing
   * (fresh content-script instance after navigation or reload) evicts its
   * predecessor's entry of the same kind, mirroring how
   * CompositeProvideAdapter.associateTab evicts a frame's stale port.
   */
  private subscribe<T>(map: Map<string, Subscription<T>>, callback: T): string {
    const { tabId, frameId } = getRpcContext();
    if (tabId !== undefined) {
      for (const [id, entry] of map) {
        if (entry.tabId === tabId && entry.frameId === frameId) {
          map.delete(id);
        }
      }
    }
    const id = crypto.randomUUID();
    map.set(id, { callback, tabId, frameId });
    return id;
  }

  /** Drop every subscription owned by a closed tab. Wired to browser.tabs.onRemoved. */
  releaseTab(tabId: number): void {
    for (const map of this.subscriptionMaps) {
      for (const [id, entry] of map) {
        if (entry.tabId === tabId) {
          map.delete(id);
        }
      }
    }
  }

  constructor(
    private hostSettingsService: HostSettingsService,
    private imageCacheService: ImageCacheService,
    private inferenceService: InferenceOrchestrationService,
    private iconService: IconService,
    private modelService: ModelService,
    private mediaFetchService: MediaFetchService,
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

  /** Drop a scrolled-away/disposed session's playback frame if it is still queued. */
  cancelVideoSessionInference(sessionId: string): Promise<void> {
    this.inferenceService.cancelVideoSession(sessionId);
    return Promise.resolve();
  }

  /**
   * Process a single GIF frame for inference.
   * Frames are decoded in the content script (ImageDecoder) and sent one-by-one,
   * mirroring video frames. Results are aggregated per GIF in the content script.
   * Chrome: Receives ImageBitmap as transferable via MessageChannel (zero-copy)
   * Firefox: Receives compressed WebP Blob via browser.runtime (structured clone)
   */
  async postInferenceGifFrame(frameData: IGifFrameTransfer): Promise<void> {
    const { hostname, src, frameIndex, frameCount, sessionId, originalWidth, originalHeight, priority } = frameData;

    if (!hostname) {
      logger.withTag('backgroundRpc').error('Hostname is required for GIF frame inference request');
      return;
    }

    try {
      const hostSettings = await this.hostSettingsService.getHostSettings(hostname);

      const input =
        frameData.kind === 'bitmap'
          ? { kind: 'bitmap' as const, imageSrc: src, bitmap: frameData.bitmap, originalWidth, originalHeight }
          : { kind: 'blob' as const, imageSrc: src, blob: frameData.blob, originalWidth, originalHeight };

      await this.inferenceService.scheduleInferenceTask({
        input,
        hostname,
        hostSettings,
        mediaMetadata: {
          kind: 'gifFrame',
          src,
          frameIndex,
          frameCount,
          sessionId,
        },
        priority,
      });
    } catch (error) {
      logger.withTag('backgroundRpc').error('Failed to schedule GIF frame inference:', hostname, error);
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

  getModelPreference(): Promise<ModelPreference> {
    return this.modelService.getModelPreference();
  }

  getEffectiveModelId(): Promise<string> {
    return Promise.resolve(this.modelService.getCurrentModelId());
  }

  getInferenceLatency(): Promise<LatencySnapshot | null> {
    return Promise.resolve(this.modelService.getInferenceLatency());
  }

  /**
   * Relay Fetch a non-CORS media URL (background is CORS-exempt); null on any
   * failure. Base64 because browser.runtime JSON-serializes ArrayBuffers away.
   */
  async fetchMediaBytes(url: string): Promise<string | null> {
    const bytes = await this.mediaFetchService.fetchMediaBytes(url);
    if (!bytes) return null;
    return encodeBase64(new Uint8Array(bytes));
  }

  /** Sizes the content-side DVR ring budget; 'unknown' until the model loads. */
  getInferenceBackend(): Promise<'webgpu' | 'wasm' | 'unknown'> {
    return Promise.resolve(this.modelService.getInferenceBackend());
  }

  // ============ Subscription Methods (replaces onMessage listeners) ============
  // Note: These return subscription IDs instead of functions because functions can't be
  // serialized over MessageChannel. Use the corresponding off* methods to unsubscribe.

  onImagePredictions(callback: ImagePredictionsCallback): string {
    return this.subscribe(this.imagePredictionsCallbacks, callback);
  }

  offImagePredictions(subscriptionId: string): void {
    this.imagePredictionsCallbacks.delete(subscriptionId);
  }

  onFramePredictions(callback: FramePredictionsCallback): string {
    return this.subscribe(this.framePredictionsCallbacks, callback);
  }

  offFramePredictions(subscriptionId: string): void {
    this.framePredictionsCallbacks.delete(subscriptionId);
  }

  onGifFramePredictions(callback: GifFramePredictionsCallback): string {
    return this.subscribe(this.gifFramePredictionsCallbacks, callback);
  }

  offGifFramePredictions(subscriptionId: string): void {
    this.gifFramePredictionsCallbacks.delete(subscriptionId);
  }

  onContextMenuToggle(callback: ContextMenuToggleCallback): string {
    return this.subscribe(this.contextMenuToggleCallbacks, callback);
  }

  offContextMenuToggle(subscriptionId: string): void {
    this.contextMenuToggleCallbacks.delete(subscriptionId);
  }

  // ============ Emit Methods ============

  emitImagePredictions(results: ImageInferenceResult[], hostname: string): void {
    this.imagePredictionsCallbacks.forEach(({ callback }) => callback({ results, hostname }));
  }

  emitFramePredictions(results: FrameInferenceResult[], hostname: string): void {
    this.framePredictionsCallbacks.forEach(({ callback }) => callback({ results, hostname }));
  }

  emitGifFramePredictions(results: GifFrameInferenceResult[], hostname: string): void {
    this.gifFramePredictionsCallbacks.forEach(({ callback }) => callback({ results, hostname }));
  }

  emitContextMenuToggle(src: string, forcedVisibility: ForcedVisibility): void {
    this.contextMenuToggleCallbacks.forEach(({ callback }) => callback({ src, forcedVisibility }));
  }
}
