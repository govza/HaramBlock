import {
  IS_CHROME,
  IMAGE_TRANSFER_KIND,
  IMAGE_FALLBACK_KIND,
  type ImageTransferKind,
  type VideoFrameTransferKind,
} from '@/utils/constants/environment';
import { logger, extractUrlId } from '@/utils/logger';
import { backgroundRpc, waitForMessageChannel } from '@/utils/messaging/content';

import type {
  IHostSettings,
  IImagePrediction,
  IImageMetadata,
  IImageTransfer,
  IVideoFrameTransfer,
} from '@/utils/types';

/**
 * Request host settings from background script
 * @param hostname - The hostname to get settings for
 * @returns Promise resolving to host settings or undefined
 */
export async function requestHostSettings(hostname: string): Promise<IHostSettings> {
  try {
    const result = await backgroundRpc.getHostSettings(hostname);
    if (!result) {
      throw new Error('No host settings returned from background script');
    }
    return result;
  } catch (error) {
    logger.withTag('sender').error('Failed to request host settings:', error);
    throw error;
  }
}

/**
 * Request cached predictions for a hostname from background script
 */
export async function requestCachedPredictions(hostname: string): Promise<IImagePrediction[]> {
  try {
    const result = await backgroundRpc.getCachedPredictions(hostname);
    return result || [];
  } catch (error) {
    logger.withTag('sender').error('Failed to request cached predictions:', error);
    return [];
  }
}

/**
 * Request background to update toggle state in cache
 */
export async function requestToggleUpdate(src: string, forcedVisibility: 'visible' | 'blocked' | null): Promise<void> {
  try {
    await backgroundRpc.updateToggleState(src, forcedVisibility);
  } catch (error) {
    logger.withTag('sender').error('Failed to update toggle state:', error);
  }
}

/**
 * Resolve image transfer kind with browser-specific fallback.
 * - Chrome: 'bitmap' primary, falls back to 'url'
 * - Firefox: 'blob' primary, falls back to 'url'
 */
async function resolveImageTransferKind(): Promise<ImageTransferKind> {
  // Chrome with bitmap requires MessageChannel
  if (IS_CHROME && IMAGE_TRANSFER_KIND === 'bitmap') {
    const channelReady = await waitForMessageChannel();
    if (!channelReady) {
      logger.withTag('sender').warn('MessageChannel not available, falling back to URL transfer');
      return IMAGE_FALLBACK_KIND;
    }
    return 'bitmap';
  }

  // Firefox or Chrome with non-bitmap: use configured kind
  return IMAGE_TRANSFER_KIND;
}

/**
 * Send image for inference using comctx RPC.
 * Transfer kind is configured in environment.ts:
 * - 'bitmap': Zero-copy ImageBitmap via MessageChannel (Chrome only)
 * - 'blob': Blob via structured clone
 * - 'url': URL only, background fetches from cache
 *
 * If the configured transfer kind fails (missing MessageChannel or fetch/CORS errors), falls back to 'url'.
 */
async function sendImageForInference(
  hostname: string,
  image: HTMLImageElement,
  metadata: IImageMetadata,
  priority: number,
): Promise<void> {
  try {
    const src = image.currentSrc || image.src;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const base = { src, width, height, hostname, metadata, priority };

    const transferKind = await resolveImageTransferKind();
    let payload: IImageTransfer | null = null;

    // Try the configured transfer kind first, fall back to URL on failure.
    const fetchImageBlob = async (): Promise<Blob> => {
      const response = await fetch(src, { cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`Failed to fetch image (${response.status})`);
      }
      return response.blob();
    };

    if (transferKind === 'bitmap') {
      try {
        const bitmap = await createImageBitmap(await fetchImageBlob());
        payload = { ...base, kind: 'bitmap', bitmap };
      } catch (error) {
        logger.withTag('sender').warn('Bitmap transfer failed, falling back to URL:', error);
      }
    } else if (transferKind === 'blob') {
      try {
        const blob = await fetchImageBlob();
        payload = { ...base, kind: 'blob', blob };
      } catch (error) {
        logger.withTag('sender').warn('Blob transfer failed, falling back to URL:', error);
      }
    }

    const finalPayload = payload ?? { ...base, kind: 'url' };
    await backgroundRpc.postInferenceImage(finalPayload);
  } catch (error) {
    logger.withTag('sender').error('Failed to send image for inference:', error);
    throw error;
  }
}

/**
 * Queue images for AI processing in background script
 * @param hostname - The hostname for these images
 * @param image - Image element to process
 * @param priority - Queue priority (higher = runs first). 10 = visible, 0 = offscreen
 * @returns Promise that resolves when images are queued
 */
export async function requestImageInference(
  hostname: string,
  image: HTMLImageElement,
  priority: number,
): Promise<void> {
  const metadata: IImageMetadata = {
    kind: 'image',
    contentType: image.dataset.contentType || null,
    contentLength: image.dataset.contentLength ? parseInt(image.dataset.contentLength) : null,
    lastModified: image.dataset.lastModified || null,
    cacheControl: image.dataset.cacheControl || null,
    etag: image.dataset.etag || null,
    expires: image.dataset.expires || null,
  };

  const src = image.currentSrc || image.src;
  logger.withTag('sender').info(`Sending image for inference: ${extractUrlId(src)}`);
  await sendImageForInference(hostname, image, metadata, priority);
}

/**
 * Request both host settings and cached predictions in parallel
 * @param hostname - The hostname to get data for
 * @returns Promise resolving to object with settings and predictions
 */
export async function requestHostData(hostname: string): Promise<{
  settings: IHostSettings;
  predictions: IImagePrediction[];
}> {
  try {
    const [settings, predictions] = await Promise.all([
      requestHostSettings(hostname),
      requestCachedPredictions(hostname),
    ]);

    return {
      settings,
      predictions,
    };
  } catch (error) {
    logger.withTag('sender').error('Failed to request host data:', error);
    throw error;
  }
}

// =============================================================================
// Video Frame Inference
// =============================================================================

/**
 * Resolve video frame transfer kind with browser-specific handling.
 * - Chrome: 'bitmap' via MessageChannel (zero-copy), no fallback (throws if unavailable)
 * - Firefox: 'blob' via structured clone (compressed WebP)
 *
 * Video frames cannot fall back to URL (they're generated in content script, not fetchable).
 * Chrome must not fall back to blob (defeats MessageChannel purpose).
 */
async function resolveVideoFrameTransferKind(): Promise<VideoFrameTransferKind> {
  // Firefox: always use blob (no MessageChannel support)
  if (!IS_CHROME) {
    return 'blob';
  }

  // Chrome: must use bitmap via MessageChannel - wait for it or throw
  const channelReady = await waitForMessageChannel();
  if (!channelReady) {
    throw new Error('MessageChannel not available for video frame transfer (Chrome requires bitmap)');
  }
  return 'bitmap';
}

/**
 * Convert ImageBitmap to compressed WebP blob for Firefox transfer
 */
async function bitmapToCompressedBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context for video frame compression');
  }
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
}

export interface VideoFrameParams {
  video: HTMLVideoElement;
  bitmap: ImageBitmap;
  hostname: string;
  sessionId: string;
  frameIndex: number;
  timestampSec: number;
  priority: number;
}

/**
 * Send video frame for inference using comctx RPC.
 * Chrome: Zero-copy ImageBitmap via MessageChannel
 * Firefox: Compressed WebP blob via structured clone
 */
export async function requestVideoFrameInference(params: VideoFrameParams): Promise<void> {
  const { video, bitmap, hostname, sessionId, frameIndex, timestampSec, priority } = params;

  try {
    const videoUrl = video.currentSrc || video.src;
    const originalWidth = video.videoWidth;
    const originalHeight = video.videoHeight;

    const base = {
      videoUrl,
      frameIndex,
      timestampSec,
      width: bitmap.width,
      height: bitmap.height,
      originalWidth,
      originalHeight,
      hostname,
      sessionId,
      priority,
    };

    const transferKind = await resolveVideoFrameTransferKind();
    let payload: IVideoFrameTransfer;

    switch (transferKind) {
      case 'bitmap': {
        // Chrome: Zero-copy transfer via MessageChannel
        payload = { ...base, kind: 'bitmap', bitmap };
        break;
      }
      case 'blob': {
        // Firefox: Compress to WebP and structured clone
        const blob = await bitmapToCompressedBlob(bitmap);
        bitmap.close(); // Clean up original bitmap after compression
        payload = { ...base, kind: 'blob', blob };
        break;
      }
      default:
        throw new Error(`Unsupported video frame transfer kind: ${transferKind as string}`);
    }

    const frameLabel = frameIndex === -1 ? 'thumbnail' : `frame ${frameIndex}`;
    logger.withTag('sender').debug(`Sending video ${frameLabel} for inference: ${extractUrlId(videoUrl)}`);

    await backgroundRpc.postInferenceVideoFrame(payload);
  } catch (error) {
    // Clean up bitmap on error if not already transferred/closed
    try {
      bitmap.close();
    } catch {
      // Already closed or transferred - ignore
    }
    logger.withTag('sender').error('Failed to send video frame for inference:', error);
    throw error;
  }
}
