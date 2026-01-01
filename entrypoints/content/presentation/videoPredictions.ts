import { markProcessed, markThumbnailProcessed } from '@/entrypoints/content/core/status';
import { clearBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { removeInitialVideoStyling } from '@/entrypoints/content/presentation/initialStyling';
import { videoMaskOverlays } from '@/entrypoints/content/presentation/videoMaskOverlay';
import { logger, extractUrlId } from '@/utils/logger';

import type { IHostSettings, IFramePrediction, IImagePrediction } from '@/utils/types';

export async function applyFramePredictionsToDom(
  framePreds: IFramePrediction[],
  hostSettings: IHostSettings,
): Promise<void> {
  const thumbnailPreds = framePreds.filter(p => p.frameIndex === -1);
  const regularPreds = framePreds.filter(p => p.frameIndex !== -1);

  if (thumbnailPreds.length > 0) {
    await processThumbnailPredictions(thumbnailPreds, hostSettings);
  }

  if (regularPreds.length > 0) {
    await processRegularFramePredictions(regularPreds, hostSettings);
  }
}

async function processThumbnailPredictions(
  thumbnailPreds: IFramePrediction[],
  hostSettings: IHostSettings,
): Promise<void> {
  const byVideoUrl = new Map<string, IFramePrediction>();
  for (const p of thumbnailPreds) byVideoUrl.set(p.videoUrl, p);
  const uniquePreds = Array.from(byVideoUrl.values());

  await Promise.all(
    uniquePreds.map(async framePred => {
      const videos = findVideosForThumbnailPrediction(framePred.videoUrl);

      if (!videos.length) {
        logger.withTag('videoPredictions').debug('No videos for thumbnail:', extractUrlId(framePred.videoUrl));
        return;
      }

      if (!framePred.predictions || framePred.predictions.length === 0) {
        for (const video of videos) {
          const videoSrc = getVideoSource(video, framePred.videoUrl);
          videoMaskOverlays.clearMaskOverlay(video);
          clearBlurBoxOverlay(video);
          removeInitialVideoStyling(video);
          markThumbnailProcessed(video, videoSrc);
          markProcessed(video, videoSrc);
        }
        return;
      }

      await Promise.all(
        videos.map(async video => {
          const videoSrc = getVideoSource(video, framePred.videoUrl);
          const imagePrediction = toImagePrediction(framePred);

          if (hostSettings.outline === 'segment') {
            await videoMaskOverlays.createMaskOverlay(video, imagePrediction, hostSettings);
          } else if (hostSettings.outline === 'bbox') {
            createVideoBlurBoxOverlays(video, imagePrediction, hostSettings);
          }

          markThumbnailProcessed(video, videoSrc);
          markProcessed(video, videoSrc);
          removeInitialVideoStyling(video);
        }),
      );
    }),
  );
}

async function processRegularFramePredictions(
  regularPreds: IFramePrediction[],
  hostSettings: IHostSettings,
): Promise<void> {
  const byVideoUrl = new Map<string, IFramePrediction>();
  for (const p of regularPreds) byVideoUrl.set(p.videoUrl, p);
  const uniquePreds = Array.from(byVideoUrl.values());

  await Promise.all(
    uniquePreds.map(async framePred => {
      const videos = findVideosForFramePrediction(framePred.videoUrl);

      if (!videos.length) {
        logger.withTag('videoPredictions').debug('No videos for frame:', extractUrlId(framePred.videoUrl));
        return;
      }

      // Emit timing for adaptive throttling
      try {
        const inferredMs = framePred.processingTime?.inferenceTime;
        if (Number.isFinite(inferredMs)) {
          globalThis.window.dispatchEvent(
            new CustomEvent('hb:inference-timing', { detail: { inferenceTime: inferredMs } }),
          );
        }
      } catch {
        // best effort
      }

      if (!framePred.predictions || framePred.predictions.length === 0) {
        for (const video of videos) {
          const videoSrc = getVideoSource(video, framePred.videoUrl);
          videoMaskOverlays.clearMaskOverlay(video);
          clearBlurBoxOverlay(video);
          removeInitialVideoStyling(video);
          markProcessed(video, videoSrc);
        }
        return;
      }

      await Promise.all(
        videos.map(async video => {
          const videoSrc = getVideoSource(video, framePred.videoUrl);
          const imagePrediction = toImagePrediction(framePred);

          if (hostSettings.outline === 'segment') {
            await videoMaskOverlays.createMaskOverlay(video, imagePrediction, hostSettings);
          } else if (hostSettings.outline === 'bbox') {
            createVideoBlurBoxOverlays(video, imagePrediction, hostSettings);
          }

          markProcessed(video, videoSrc);
          removeInitialVideoStyling(video);
        }),
      );
    }),
  );
}

function toImagePrediction(framePred: IFramePrediction): IImagePrediction {
  return {
    src: framePred.videoUrl,
    predictions: framePred.predictions,
    width: framePred.width,
    height: framePred.height,
    hostname: framePred.hostname,
    timestamp: framePred.timestamp,
    cacheMetadata: framePred.cacheMetadata,
    maskTransform: framePred.maskTransform,
    processingTime: framePred.processingTime,
    forcedVisibility: null,
  };
}

function createVideoBlurBoxOverlays(
  video: HTMLVideoElement,
  prediction: IImagePrediction,
  hostSettings: IHostSettings,
): void {
  clearBlurBoxOverlay(video);

  void import('@/entrypoints/content/presentation/boundingBox').then(({ createBlurBoxOverlays }) => {
    createBlurBoxOverlays(video, prediction, hostSettings);
  });
}

function getVideoSource(video: HTMLVideoElement, fallbackSrc: string): string {
  return video.dataset.hbSrc || video.currentSrc || video.src || fallbackSrc;
}

function findVideosBySrc(videoUrl: string, attr: string): HTMLVideoElement[] {
  try {
    const selector = `video[data-hb-src="${CSS.escape(videoUrl)}"][${attr}]`;
    return Array.from(document.querySelectorAll<HTMLVideoElement>(selector));
  } catch {
    return [];
  }
}

function findVideosForThumbnailPrediction(videoUrl: string): HTMLVideoElement[] {
  return findVideosBySrc(videoUrl, 'data-hb-handled="1"');
}

function findVideosForFramePrediction(videoUrl: string): HTMLVideoElement[] {
  const processing = findVideosBySrc(videoUrl, 'data-hb-video-status="processing"');
  if (processing.length) return processing;
  return findVideosBySrc(videoUrl, 'data-hb-handled="1"');
}
