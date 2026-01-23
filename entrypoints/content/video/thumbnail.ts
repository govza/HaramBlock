import { requestVideoFrameInference } from '@/entrypoints/content/communication/sender';
import {
  isThumbnailProcessed,
  isThumbnailSentForInference,
  markThumbnailProcessed,
  markThumbnailSentForInference,
} from '@/entrypoints/content/core/status';
import { captureThumbnailBitmap } from '@/entrypoints/content/video/frameCapture';
import { logger } from '@/utils/logger';

import type { IHostSettings } from '@/utils/types';

/**
 * Process and send video thumbnail for inference.
 * Handles both poster images and first-frame fallback via captureThumbnailBitmap.
 * Returns 'sent' if thumbnail was captured and sent, 'skipped' if already processed or failed.
 */
export async function processThumbnail(
  video: HTMLVideoElement,
  src: string,
  hostSettings: IHostSettings,
): Promise<'sent' | 'skipped'> {
  if (isThumbnailProcessed(video, src) || isThumbnailSentForInference(video, src)) {
    return 'skipped';
  }

  let bitmap: ImageBitmap | null = null;

  try {
    // captureThumbnailBitmap handles:
    // 1. video.poster attribute (loads as image)
    // 2. Falls back to first video frame
    bitmap = await captureThumbnailBitmap(video);

    if (!bitmap) {
      logger.withTag('thumbnail').warn('Could not extract thumbnail frame', { src });
      markThumbnailProcessed(video, src);
      return 'skipped';
    }

    if (bitmap.width === 0 || bitmap.height === 0) {
      logger.withTag('thumbnail').warn('Thumbnail has zero dimensions', { src });
      bitmap.close();
      markThumbnailProcessed(video, src);
      return 'skipped';
    }

    // Get or create sessionId for this video
    const sessionId = video.dataset.hbSessionId || crypto.randomUUID();
    video.dataset.hbSessionId = sessionId;

    // requestVideoFrameInference handles bitmap ownership:
    // - Chrome: transfers bitmap via MessageChannel (zero-copy)
    // - Firefox: compresses to WebP blob and closes bitmap
    await requestVideoFrameInference({
      video,
      bitmap,
      hostname: hostSettings.hostname,
      sessionId,
      frameIndex: -1,
      timestampSec: 0,
      priority: 10,
    });

    markThumbnailSentForInference(video, src);
    return 'sent';
  } catch (error) {
    // Clean up bitmap on error if not transferred
    if (bitmap) {
      try {
        bitmap.close();
      } catch {
        // Bitmap may already be transferred or closed - ignore
      }
    }
    logger.withTag('thumbnail').error('Failed to process video thumbnail:', error);
    markThumbnailProcessed(video, src);
    return 'skipped';
  }
}

/**
 * Queue thumbnail for inference when video is ready.
 * Waits for loadeddata event if video is not yet ready.
 */
export function queueThumbnailForInference(video: HTMLVideoElement, src: string, hostSettings: IHostSettings): void {
  const processThumbnailNow = async () => {
    try {
      await processThumbnail(video, src, hostSettings);
    } catch (error) {
      logger.withTag('thumbnail').error('Thumbnail processing failed:', error);
      markThumbnailProcessed(video, src);
    }
  };

  // Try to process thumbnail immediately if video has enough data
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    void processThumbnailNow();
    return;
  }

  // Wait for video data to be loaded
  video.addEventListener('loadeddata', () => void processThumbnailNow(), { once: true });
}
