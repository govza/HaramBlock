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

export async function processThumbnail(
  video: HTMLVideoElement,
  src: string,
  sendSample: (video: HTMLVideoElement, bitmap: ImageBitmap) => Promise<void>,
): Promise<'sent' | 'skipped'> {
  if (isThumbnailProcessed(video, src) || isThumbnailSentForInference(video, src)) {
    return 'skipped';
  }

  let bitmap: ImageBitmap | null = null;

  try {
    bitmap = await captureThumbnailBitmap(video);

    if (!bitmap) {
      logger.withTag('thumbnail').warn('Could not extract thumbnail frame', { src });
      markThumbnailProcessed(video, src);
      return 'skipped';
    }

    await sendSample(video, bitmap);
    return 'sent';
  } catch (error) {
    logger.withTag('thumbnail').error('Failed to process video thumbnail:', error);
    markThumbnailProcessed(video, src);
    return 'skipped';
  } finally {
    bitmap?.close();
  }
}

/** Queue thumbnail for inference */
export function queueThumbnailForInference(video: HTMLVideoElement, src: string, hostSettings: IHostSettings): void {
  const processThumbnailNow = async () => {
    try {
      // Get or create sessionId for this video
      const sessionId = video.dataset.hbSessionId || crypto.randomUUID();
      video.dataset.hbSessionId = sessionId;

      const result = await processThumbnail(video, src, async (vid, bitmap) => {
        // Use bitmap's intrinsic dimensions (poster) for thumbnails
        const {width} = bitmap;
        const {height} = bitmap;

        if (width === 0 || height === 0) {
          throw new Error('Cannot send video thumbnail with zero dimensions');
        }

        // Create blob URL for this thumbnail
        const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = offscreen.getContext('2d');
        if (!ctx) {
          throw new Error('Failed to get 2D context for thumbnail');
        }
        ctx.drawImage(bitmap, 0, 0);
        const blob = await offscreen.convertToBlob({ type: 'image/webp', quality: 0.9 });
        const blobUrl = URL.createObjectURL(blob);

        await requestVideoFrameInference({
          hostname: hostSettings.hostname,
          frameSrc: blobUrl,
          videoUrl: src,
          bitmap,
          width,
          height,
          frameIndex: -1,
          timestamp: 0,
          sessionId,
        });
      });

      if (result === 'sent') {
        markThumbnailSentForInference(video, src);
      }
    } catch (error) {
      logger.withTag('thumbnail').error('Thumbnail processing failed:', error);
      markThumbnailProcessed(video, src);
    }
  };

  // Try to process thumbnail immediately if video is ready
  if (video.readyState >= 2) {
    void processThumbnailNow();
    return;
  }

  const onLoadedData = () => {
    void processThumbnailNow();
  };
  video.addEventListener('loadeddata', onLoadedData, { once: true });
}
