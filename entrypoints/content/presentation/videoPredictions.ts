import { markProcessed, markThumbnailProcessed } from '@/entrypoints/content/core/status';
import { clearBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { removeInitialVideoStyling } from '@/entrypoints/content/presentation/initialStyling';
import { applyPredictionsStyling } from '@/entrypoints/content/presentation/predictionStyling';
import { videoMaskOverlays } from '@/entrypoints/content/presentation/videoMaskOverlay';
import { logger } from '@/utils/logger';

import type { IHostSettings, IFramePrediction } from '@/utils/types';

/**
 * Applies video frame predictions to DOM elements.
 * Handles both thumbnail predictions (frameIndex: -1) and regular frame predictions.
 * Follows the same pattern as applyPredictionsToDom for images.
 */
export async function applyFramePredictionsToDom(
  framePreds: IFramePrediction[],
  hostSettings: IHostSettings,
): Promise<void> {
  // Separate thumbnail predictions from regular frame predictions
  const thumbnailPreds = framePreds.filter(p => p.frameIndex === -1);
  const regularPreds = framePreds.filter(p => p.frameIndex !== -1);

  // Handle thumbnail predictions first
  if (thumbnailPreds.length > 0) {
    await processThumbnailPredictions(thumbnailPreds, hostSettings);
  }

  // Handle regular frame predictions
  if (regularPreds.length > 0) {
    await processRegularFramePredictions(regularPreds, hostSettings);
  }
}

/**
 * Process thumbnail predictions (frameIndex: -1)
 */
async function processThumbnailPredictions(
  thumbnailPreds: IFramePrediction[],
  hostSettings: IHostSettings,
): Promise<void> {
  // Deduplicate by video URL to avoid re-applying overlays multiple times per batch
  const bySrc = new Map<string, IFramePrediction>();
  for (const p of thumbnailPreds) bySrc.set(p.videoUrl, p);
  const uniquePreds = Array.from(bySrc.values());

  await Promise.all(
    uniquePreds.map(async framePred => {
      const videos = findVideosForThumbnailPrediction(framePred.videoUrl);

      if (!videos.length) {
        return;
      }

      const predictions = framePred.predictions || [];

      if (predictions.length === 0) {
        for (const video of videos) {
          const videoSrc = getVideoSource(video, framePred.videoUrl);
          videoMaskOverlays.clearMaskOverlay(video);
          clearBlurBoxOverlay(video as unknown as HTMLImageElement);
          removeInitialVideoStyling(video);
          markThumbnailProcessed(video, videoSrc);
          markProcessed(video, videoSrc);
        }
        return;
      }

      // Apply video-specific styling based on outline preference
      await Promise.all(
        videos.map(async video => {
          const videoSrc = getVideoSource(video, framePred.videoUrl);

          const imagePrediction = {
            src: videoSrc,
            predictions,
            width: framePred.width,
            height: framePred.height,
            imageWidth: framePred.width,
            imageHeight: framePred.height,
            hostname: hostSettings.hostname,
            timestamp: Date.now(),
            cacheMetadata: {
              contentType: 'video/thumbnail',
              createdAt: Date.now(),
              accessedAt: Date.now(),
            },
            maskTransform: framePred.maskTransform,
            processingTime: {
              bitmapTime: framePred.processingTime.bitmapTime,
              fetchTime: framePred.processingTime.fetchTime,
              inferenceTime: framePred.processingTime.inferenceTime,
            },
          };

          if (hostSettings.outline === 'segment' && hostSettings.masking.blur) {
            // Use dedicated video overlay system for segmentation
            await videoMaskOverlays.createMaskOverlay(video, imagePrediction);
          } else if (hostSettings.outline === 'bbox' && hostSettings.masking.blur) {
            // Use bbox system with video element directly (no conversion needed)
            await applyPredictionsStyling([video], [imagePrediction], hostSettings);
          } else {
            logger.withTag('videoPredictions').warn('No styling applied - conditions not met:', {
              outline: hostSettings.outline,
              maskingBlur: hostSettings.masking.blur,
              needsSegmentAndBlur: true,
            });
          }

          markThumbnailProcessed(video, videoSrc);
          markProcessed(video, videoSrc);
          removeInitialVideoStyling(video);
        }),
      );
    }),
  );
}

/**
 * Process regular frame predictions (for real-time video processing)
 */
async function processRegularFramePredictions(
  regularPreds: IFramePrediction[],
  hostSettings: IHostSettings,
): Promise<void> {
  // Deduplicate by video URL to avoid re-applying overlays multiple times per batch
  const bySrc = new Map<string, IFramePrediction>();
  for (const p of regularPreds) bySrc.set(p.videoUrl, p);
  const uniquePreds = Array.from(bySrc.values());

  const processFramePrediction = async (framePred: IFramePrediction): Promise<void> => {
    const videos = findVideosForPrediction(framePred.videoUrl);

    if (!videos.length) {
      return;
    }

    if (!framePred.predictions || framePred.predictions.length === 0) {
      for (const video of videos) {
        const videoSrc = getVideoSource(video, framePred.videoUrl);
        videoMaskOverlays.clearMaskOverlay(video);
        clearBlurBoxOverlay(video as unknown as HTMLImageElement);
        removeInitialVideoStyling(video);
        markProcessed(video, videoSrc);
      }
      return;
    }

    // Surface latest inference timing for adaptive throttling in sender loop
    try {
      const inferredMs = framePred.processingTime?.inferenceTime;
      if (Number.isFinite(inferredMs)) {
        globalThis.window.dispatchEvent(
          new CustomEvent('hb:inference-timing', { detail: { inferenceTime: inferredMs } }),
        );
      }
    } catch {
      // best effort only
    }

    // Apply video-specific styling based on outline preference for regular frames
    await Promise.all(
      videos.map(async video => {
        const videoSrc = getVideoSource(video, framePred.videoUrl);
        const imagePrediction = {
          src: videoSrc,
          predictions: framePred.predictions,
          width: framePred.width,
          height: framePred.height,
          imageWidth: framePred.width,
          imageHeight: framePred.height,
          hostname: hostSettings.hostname,
          timestamp: Date.now(),
          cacheMetadata: {
            contentType: 'video/frame',
            createdAt: Date.now(),
            accessedAt: Date.now(),
          },
          maskTransform: framePred.maskTransform,
          processingTime: {
            bitmapTime: framePred.processingTime.bitmapTime,
            fetchTime: framePred.processingTime.fetchTime,
            inferenceTime: framePred.processingTime.inferenceTime,
          },
        };

        if (hostSettings.outline === 'segment' && hostSettings.masking.blur) {
          // Use dedicated video overlay system for segmentation
          // Note: For real-time frames, we might want to use the actual video frame
          // rather than poster, but for now use the same system
          await videoMaskOverlays.createMaskOverlay(video, imagePrediction);
        } else if (hostSettings.outline === 'bbox' && hostSettings.masking.blur) {
          // Use bbox system with video element directly (no conversion needed)
          await applyPredictionsStyling([video], [imagePrediction], hostSettings);
        }

        markProcessed(video, videoSrc);
        removeInitialVideoStyling(video);
      }),
    );
  };

  await Promise.all(uniquePreds.map(processFramePrediction));
}

function getVideoSource(video: HTMLVideoElement, fallbackSrc: string): string {
  return video.dataset.hbSrc || video.currentSrc || video.src || fallbackSrc;
}

function findVideosForThumbnailPrediction(src: string): HTMLVideoElement[] {
  try {
    // Find videos that have been handled and have the matching src
    // Thumbnail predictions can apply to videos in any state (not just "processing")
    const selector = `video[data-hb-src="${CSS.escape(src)}"][data-hb-handled="1"]`;
    const directMatches = Array.from(document.querySelectorAll<HTMLVideoElement>(selector));
    if (directMatches.length) {
      return directMatches;
    }
  } catch {
    // CSS.escape may not be available in extremely old browsers; fall back below.
  }

  // Fallback: find all handled videos and filter by source
  const handledVideos = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-hb-handled="1"]'));
  return handledVideos.filter(video => getVideoSource(video, src) === src);
}

function findVideosForPrediction(src: string): HTMLVideoElement[] {
  try {
    const selector = `video[data-hb-src="${CSS.escape(src)}"][data-hb-video-status="processing"]`;
    const directMatches = Array.from(document.querySelectorAll<HTMLVideoElement>(selector));
    if (directMatches.length) {
      return directMatches;
    }
  } catch {
    // CSS.escape may not be available in extremely old browsers; fall back below.
  }

  const processingVideos = findAllProcessingVideos();
  return processingVideos.filter(video => getVideoSource(video, src) === src);
}

function findAllProcessingVideos(): HTMLVideoElement[] {
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-hb-video-status="processing"]'));
  return videos;
}
