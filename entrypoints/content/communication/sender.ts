import { sendMessage } from 'webext-bridge/content-script';

import { getMessagePort } from '@/entrypoints/content/communication/messageChannel';
import { logger } from '@/utils/logger';

import type {
  IHostSettings,
  IImagePrediction,
  IImageMetadata,
  IImageWithMetadata,
  ChannelRequest,
  ProcessImageAction,
  IImageWithBitmap,
} from '@/utils/types';

/**
 * Communication sender module for HaramBlock content script
 */

/**
 * Feature flag to disable MessageChannel and force sendMessage usage
 */
const isMessageChannelDisabled = import.meta.env.MODE === 'no-channel';

/**
 * Request host settings from background script
 * @param hostname - The hostname to get settings for
 * @returns Promise resolving to host settings or undefined
 */
export async function requestHostSettings(hostname: string): Promise<IHostSettings> {
  try {
    const result = await sendMessage('GET_HOST_SETTINGS', { hostname }, 'background');
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
    const result = await sendMessage('GET_HOSTNAME_IMAGE_PREDICTION_CACHE', { hostname }, 'background');
    return result || [];
  } catch (error) {
    logger.withTag('sender').error('Failed to request cached predictions:', error);
    return [];
  }
}

/**
 * Send image for inference using MessageChannel (transferables when possible)
 * Thin wrapper to allow branching from queueImagesForInference.
 */
async function sendImageForInferenceUsingChannel(
  port: MessagePort,
  hostname: string,
  image: HTMLImageElement,
  metadata: IImageMetadata,
): Promise<void> {
  let img = image;
  try {
    const src = image.currentSrc || image.src;
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;

    img = await loadImage(src, metadata);

    // Create a bitmap at natural resolution to avoid aspect distortion.
    // Background will handle aspect-preserving letterboxing to 640x640.
    const bitmap = await createImageBitmap(img);

    // Create payload for PROCESS_IMAGE action
    const payload: IImageWithBitmap = {
      src,
      width: naturalWidth,
      height: naturalHeight,
      bitmap,
      hostname,
      tabId: browser.devtools?.inspectedWindow?.tabId || 0,
      metadata,
    };

    // Wrap in ChannelRequest format
    const request: ChannelRequest<ProcessImageAction, IImageWithBitmap> = {
      id: crypto.randomUUID(),
      type: 'request',
      action: 'PROCESS_IMAGE',
      payload,
    };

    port.postMessage(request, [bitmap]);
  } catch (error) {
    logger.withTag('sender').error('Failed to prepare image for inference:', error);
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

  const imageData: IImageWithMetadata = {
    src: image.currentSrc || image.src,
    width: image.naturalWidth || image.width || 0,
    height: image.naturalHeight || image.height || 0,
    metadata,
  };

  // Attempt to use MessageChannel with transferables (unless disabled)
  if (!isMessageChannelDisabled) {
    const port = getMessagePort();
    if (port) {
      try {
        logger.withTag('sender').info(`Attempting to send via MessageChannel for ${imageData.src.substring(0, 50)}...`);
        await sendImageForInferenceUsingChannel(port, hostname, image, metadata);
        return;
      } catch (error) {
        logger.withTag('sender').warn(`MessageChannel failed, falling back to webext-bridge:`, error);
        // Fallback to webext-bridge below
      }
    }
  }

  await sendMessage('POST_INFERENCE_IMAGES', { hostname, imageData }, 'background');
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

function loadImage(src: string, metadata: IImageMetadata): Promise<HTMLImageElement> {
  const { width, height } = metadata;

  let image: HTMLImageElement;
  if (width && height) {
    image = new Image(Number(width), Number(height));
  } else {
    image = new Image();
  }
  image.crossOrigin = 'anonymous';
  image.src = src;

  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
  });
}
