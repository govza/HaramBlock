import { IMAGE_TRANSFER_KIND, type ImageTransferKind } from '@/utils/constants/environment';
import { logger, extractUrlId } from '@/utils/logger';
import { backgroundRpc, waitForMessageChannel } from '@/utils/messaging/content';

import type { IHostSettings, IImagePrediction, IImageMetadata, IImageTransfer } from '@/utils/types';

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
 * @param hostname - The hostname to get cached predictions for
 * @returns Promise resolving to array of cached predictions
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
 * Resolve transfer kind with fallback.
 * If 'bitmap' is requested but MessageChannel is not available, falls back to 'url'.
 */
async function resolveTransferKind(): Promise<ImageTransferKind> {
  if (IMAGE_TRANSFER_KIND !== 'bitmap') {
    return IMAGE_TRANSFER_KIND;
  }

  // bitmap requires MessageChannel - wait for it or fall back to url
  const channelReady = await waitForMessageChannel();
  if (!channelReady) {
    logger.withTag('sender').warn('MessageChannel not available, falling back to URL transfer');
    return 'url';
  }
  return 'bitmap';
}

/**
 * Send image for inference using comctx RPC.
 * Transfer kind is configured in environment.ts:
 * - 'bitmap': Zero-copy ImageBitmap via MessageChannel (Chrome only)
 * - 'blob': Blob via structured clone
 * - 'url': URL only, background fetches from cache
 *
 * If 'bitmap' is configured but MessageChannel is unavailable, falls back to 'url'.
 */
async function sendImageForInference(
  hostname: string,
  image: HTMLImageElement,
  metadata: IImageMetadata,
): Promise<void> {
  try {
    const src = image.currentSrc || image.src;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const base = { src, width, height, hostname, metadata };

    const transferKind = await resolveTransferKind();
    let payload: IImageTransfer;

    switch (transferKind) {
      case 'bitmap': {
        // Fetch and convert to ImageBitmap for zero-copy transfer
        const response = await fetch(src);
        const blob = await response.blob();
        payload = { ...base, kind: 'bitmap', bitmap: await createImageBitmap(blob) };
        break;
      }
      case 'blob': {
        // Fetch and send as Blob (structured clone, ~25MB overhead)
        const response = await fetch(src);
        const blob = await response.blob();
        payload = { ...base, kind: 'blob', blob };
        break;
      }
      case 'url':
        // Send URL only, background fetches from cache
        payload = { ...base, kind: 'url' };
        break;
      default:
        throw new Error(`Unsupported image transfer kind: ${transferKind as string}`);
    }

    await backgroundRpc.postInferenceImage(payload);
  } catch (error) {
    logger.withTag('sender').error('Failed to send image for inference:', error);
    throw error;
  }
}

/**
 * Queue images for AI processing in background script
 * @param hostname - The hostname for these images
 * @param image - Image element to process
 * @returns Promise that resolves when images are queued
 */
export async function requestImageInference(hostname: string, image: HTMLImageElement): Promise<void> {
  const metadata = {
    width: image.naturalWidth || image.width || undefined,
    height: image.naturalHeight || image.height || undefined,
    contentType: image.dataset.contentType || undefined,
    contentLength: image.dataset.contentLength ? parseInt(image.dataset.contentLength) : undefined,
    lastModified: image.dataset.lastModified || undefined,
    cacheControl: image.dataset.cacheControl || undefined,
    etag: image.dataset.etag || undefined,
    expires: image.dataset.expires || undefined,
  } as IImageMetadata;

  const src = image.currentSrc || image.src;
  logger.withTag('sender').info(`Sending image for inference: ${extractUrlId(src)}`);
  await sendImageForInference(hostname, image, metadata);
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
