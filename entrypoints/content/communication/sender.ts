import {
  IS_CHROME,
  IMAGE_TRANSFER_KIND,
  IMAGE_FALLBACK_KIND,
  type ImageTransferKind,
  type VideoFrameTransferKind,
} from '@/utils/constants/environment';
import { logger } from '@/utils/logger';
import { backgroundRpc, waitForMessageChannel } from '@/utils/messaging/content';

import type { CapturedFrameSample } from '@/entrypoints/content/video/frameSample';
import type {
  ForcedVisibility,
  IHostSettings,
  IImagePrediction,
  IImageMetadata,
  IImageTransfer,
  IVideoFrameTransfer,
  IGifFrameTransfer,
} from '@/utils/types';

/**
 * Request host settings from background script
 * @param hostname - The hostname to get settings for
 * @returns Promise resolving to host settings or undefined
 */
export async function requestHostSettings(hostname: string): Promise<IHostSettings> {
  try {
    const isIncognito = browser.extension.inIncognitoContext;
    const result = await backgroundRpc.getHostSettings(hostname, isIncognito);
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
export async function requestToggleUpdate(src: string, forcedVisibility: ForcedVisibility): Promise<void> {
  try {
    await backgroundRpc.updateToggleState(src, forcedVisibility);
  } catch (error) {
    logger.withTag('sender').error('Failed to update toggle state:', error);
  }
}

/**
 * Reset badge count for the current tab.
 * Called on new document startup to avoid stale badge values across reloads/navigation.
 */
export async function resetBadgeCount(): Promise<void> {
  try {
    await backgroundRpc.updateIconBadge(0, globalThis.location.href);
  } catch (error) {
    logger.withTag('sender').error('Failed to reset badge count:', error);
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

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

async function buildPayload(
  hostname: string,
  image: HTMLImageElement,
  metadata: IImageMetadata,
  priority: number,
): Promise<IImageTransfer> {
  const requestStartAt = Date.now();
  const src = image.currentSrc || image.src;
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const transferKind = await resolveImageTransferKind();

  const fetchImageBlob = async (): Promise<{ blob: Blob; fetchTime: number }> => {
    const fetchStart = Date.now();
    const response = await fetch(src, { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`Failed to fetch image (${response.status})`);
    }
    const blob = await response.blob();
    return { blob, fetchTime: Date.now() - fetchStart };
  };

  if (transferKind === 'bitmap') {
    try {
      const { blob, fetchTime } = await fetchImageBlob();
      const decodeStart = Date.now();
      const bitmap = await createImageBitmap(blob);
      const decodeTime = Date.now() - decodeStart;
      return {
        src,
        width,
        height,
        hostname,
        metadata,
        priority,
        requestStartAt,
        fetchTime,
        decodeTime,
        kind: 'bitmap',
        bitmap,
      };
    } catch (error) {
      logger.withTag('sender').warn('Bitmap transfer failed, falling back to URL:', error);
    }
  } else if (transferKind === 'blob') {
    try {
      const { blob, fetchTime } = await fetchImageBlob();
      return { src, width, height, hostname, metadata, priority, requestStartAt, fetchTime, kind: 'blob', blob };
    } catch (error) {
      logger.withTag('sender').warn('Blob transfer failed, falling back to URL:', error);
    }
  }

  if (src.startsWith('blob:')) {
    throw new Error(`Cannot process blob URL: inaccessible from extension contexts`);
  }

  return { src, width, height, hostname, metadata, priority, requestStartAt, kind: 'url' };
}

/**
 * Send image for inference using comctx RPC.
 * Transfer kind is configured in environment.ts:
 * - 'bitmap': Zero-copy ImageBitmap via MessageChannel (Chrome only)
 * - 'blob': Blob via structured clone
 * - 'url': URL only, background fetches from cache
 *
 * If the configured transfer kind fails (missing MessageChannel or fetch/CORS errors), falls back to 'url'.
 * Retries on heartbeat/provider errors since the service worker may restart.
 */
async function sendImageForInference(
  hostname: string,
  image: HTMLImageElement,
  metadata: IImageMetadata,
  priority: number,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const payload = await buildPayload(hostname, image, metadata, priority);
      await backgroundRpc.postInferenceImage(payload);
      return;
    } catch (error) {
      lastError = error;
      const isProviderError = error instanceof Error && error.message.includes('Provider unavailable');
      if (!isProviderError || attempt === MAX_RETRIES) break;
      logger.withTag('sender').warn(`Inference send failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  logger.withTag('sender').error('Failed to send image for inference:', lastError);
  throw lastError;
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
  sample: CapturedFrameSample;
  hostname: string;
  priority: number;
}

/**
 * Send video frame for inference using comctx RPC.
 * Chrome: Zero-copy ImageBitmap via MessageChannel
 * Firefox: Compressed WebP blob via structured clone
 */
export async function requestVideoFrameInference(params: VideoFrameParams): Promise<void> {
  const { sample, hostname, priority } = params;
  const { bitmap, videoUrl, frameIndex, timestampSec, sessionId, originalWidth, originalHeight } = sample;

  try {
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

// =============================================================================
// GIF Frame Inference
// =============================================================================

export interface GifFrameParams {
  src: string;
  bitmap: ImageBitmap;
  hostname: string;
  sessionId: string;
  frameIndex: number;
  frameCount: number;
  originalWidth: number;
  originalHeight: number;
  priority: number;
}

/**
 * Send a single decoded GIF frame for inference.
 * Uses the same transport as video frames (frames are generated in content, not
 * fetchable): Chrome transfers a zero-copy ImageBitmap via MessageChannel, Firefox
 * sends a compressed WebP blob. Takes ownership of the bitmap.
 */
export async function requestGifFrameInference(params: GifFrameParams): Promise<void> {
  const { src, bitmap, hostname, sessionId, frameIndex, frameCount, originalWidth, originalHeight, priority } = params;

  try {
    const base = {
      src,
      frameIndex,
      frameCount,
      sessionId,
      width: bitmap.width,
      height: bitmap.height,
      originalWidth,
      originalHeight,
      hostname,
      priority,
    };

    const transferKind = await resolveVideoFrameTransferKind();
    let payload: IGifFrameTransfer;

    switch (transferKind) {
      case 'bitmap': {
        payload = { ...base, kind: 'bitmap', bitmap };
        break;
      }
      case 'blob': {
        const blob = await bitmapToCompressedBlob(bitmap);
        bitmap.close();
        payload = { ...base, kind: 'blob', blob };
        break;
      }
      default:
        throw new Error(`Unsupported GIF frame transfer kind: ${transferKind as string}`);
    }

    await backgroundRpc.postInferenceGifFrame(payload);
  } catch (error) {
    try {
      bitmap.close();
    } catch {
      // Already closed or transferred - ignore
    }
    logger.withTag('sender').error('Failed to send GIF frame for inference:', error);
    throw error;
  }
}
