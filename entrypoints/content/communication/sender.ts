import { sendMessage } from 'webext-bridge/content-script';

import { logger } from '@/utils/logger';
import { type IHostSettings, type IImagePrediction, type IImageMetadata, type IImageWithMetadata } from '@/utils/types';

/**
 * Communication sender module for HaramBlock content script
 */

/**
 * Request host settings from background script
 * @param hostname - The hostname to get settings for
 * @returns Promise resolving to host settings or undefined
 */
export async function requestHostSettings(hostname: string): Promise<IHostSettings | undefined> {
  try {
    return await sendMessage('GET_HOST_SETTINGS', { hostname }, 'background');
  } catch (error) {
    logger.withTag('sender').error('Failed to request host settings:', error);
    return undefined;
  }
}

/**
 * Request cached predictions for a hostname from background script
 * @param hostname - The hostname to get cached predictions for
 * @returns Promise resolving to array of cached predictions
 */
export async function requestCachedPredictions(hostname: string): Promise<IImagePrediction[]> {
  try {
    const result = await sendMessage('GET_HOSTNAME_IMAGE_PREDICTION_CACHE', { hostname }, 'background');
    return result || [];
  } catch (error) {
    logger.withTag('sender').error('Failed to request cached predictions:', error);
    return [];
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

  const imageData: IImageWithMetadata = {
    src: image.currentSrc || image.src,
    width: image.naturalWidth || image.width || 0,
    height: image.naturalHeight || image.height || 0,
    metadata,
  };

  await sendMessage('POST_INFERENCE_IMAGES', { hostname, imageData }, 'background');
}

/**
 * Request both host settings and cached predictions in parallel
 * @param hostname - The hostname to get data for
 * @returns Promise resolving to object with settings and predictions
 */
export async function requestHostData(hostname: string): Promise<{
  settings: IHostSettings | undefined;
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
    return {
      settings: undefined,
      predictions: [],
    };
  }
}
