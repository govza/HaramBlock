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
  IFrameWithMetadata,
  IFrameWithBitmap,
  IVideo,
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
    const result = (await sendMessage(
      'GET_HOSTNAME_IMAGE_PREDICTION_CACHE',
      { hostname },
      'background',
    )) as unknown as IImagePrediction[];
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
  const tabId = await sendMessage('GET_CURRENT_TAB_ID', 'get', 'background');
  let img = image;
  try {
    const src = image.currentSrc || image.src;
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;

    img = await loadImage(src);

    // Create a bitmap at natural resolution to avoid aspect distortion.
    // Background will handle aspect-preserving letterboxing to 640x640.
    const bitmap = await createImageBitmap(img);

    // Create payload for PROCESS_IMAGE action
    const payload: IImageWithBitmap = {
      media: 'image',
      transport: 'transferable',
      src,
      width: naturalWidth,
      height: naturalHeight,
      bitmap,
      hostname,
      tabId,
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
  const metadata: IImageMetadata = {
    contentType: image.dataset.contentType || null,
    contentLength: image.dataset.contentLength ? parseInt(image.dataset.contentLength) : null,
    lastModified: image.dataset.lastModified || null,
    cacheControl: image.dataset.cacheControl || null,
    etag: image.dataset.etag || null,
    expires: image.dataset.expires || null,
  };

  const imageData: IImageWithMetadata = {
    media: 'image',
    transport: 'serializable',
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

  await sendMessage('POST_IMAGE', { hostname, imageData }, 'background');
}

/**
 * Start video inference by sending video metadata to background script
 * @param video - Video metadata to send
 */
export async function requestVideoInference(
  hostname: string,
  video: Extract<IVideo, { type: 'start' }>,
): Promise<void> {
  try {
    await sendMessage('POST_VIDEO', { hostname, video }, 'background');
  } catch (error) {
    logger.withTag('sender').warn('Failed to create video:', error);
  }
}

/**
 * Request video frame inference using MessageChannel with an ImageBitmap (preferred path).
 * Falls back to bridge messaging if channel setup or send fails.
 */
export async function requestVideoFrameInference(args: {
  hostname: string;
  frameSrc: string; // blob URL of the extracted frame (for inference)
  videoUrl: string; // original video URL (for DOM matching)
  bitmap: ImageBitmap;
  width: number;
  height: number;
  frameIndex: number;
  timestamp: number; // seconds
  sessionId: string; // stable ID for the video session
  tabId?: number;
}): Promise<void> {
  const { hostname, frameSrc, videoUrl, bitmap, width, height, frameIndex, timestamp, sessionId, tabId } = args;
  // Resolve tabId strictly from content context
  let resolvedTabId = tabId;
  if (resolvedTabId == null) {
    resolvedTabId = await sendMessage('GET_CURRENT_TAB_ID', 'get', 'background');
  }

  // Build metadata indicating this payload is a video frame
  const metadata: IImageMetadata = {
    contentType: 'video/frame',
    contentLength: null,
    lastModified: null,
    cacheControl: null,
    etag: null,
    expires: null,
  };

  // Try using the high-performance MessageChannel first only if we have a valid tabId
  if (resolvedTabId != null && !isMessageChannelDisabled) {
    const port = getMessagePort();
    if (port) {
      try {
        // Build payload for channel path WITHOUT forcing blob creation.
        const channelPayload: IFrameWithBitmap = {
          media: 'frame',
          transport: 'transferable',
          // Background requires a non-empty src but does not fetch it for bitmap path.
          // Use a stable synthetic ID based on video URL and frame index to avoid blob work.
          src: `${videoUrl}#f=${frameIndex}`,
          width,
          height,
          bitmap,
          hostname,
          tabId: resolvedTabId,
          metadata,
          sessionId,
          videoUrl,
          frameIndex,
          timestampSec: timestamp,
        };

        const request: ChannelRequest<ProcessImageAction, IFrameWithBitmap> = {
          id: crypto.randomUUID(),
          type: 'request',
          action: 'PROCESS_IMAGE',
          payload: channelPayload,
        };

        port.postMessage(request, [bitmap]);
        return;
      } catch (err) {
        logger.withTag('sender').warn('Channel send for video frame failed, falling back:', err);
      }
    }
  }

  // Fallback: convert bitmap to Blob and use bridge message
  try {
    // Only create a blob for the fallback bridge path.
    const off = new OffscreenCanvas(width, height);
    const ctx = off.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await off.convertToBlob({ type: 'image/webp', quality: 0.7 });
    const blobSrc = frameSrc && frameSrc.trim().length > 0 ? frameSrc : URL.createObjectURL(blob);
    const frameData: IFrameWithMetadata = {
      media: 'frame',
      transport: 'serializable',
      src: blobSrc,
      width,
      height,
      sessionId,
      videoUrl,
      frameIndex,
      timestampSec: timestamp,
      metadata,
    };

    await sendMessage('POST_FRAME', { hostname, frameData }, 'background');
  } catch (error) {
    logger.withTag('sender').error('Failed to send video frame for inference:', error);
    throw error;
  }
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

function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = src;

  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
  });
}
