import { isHandled, markHandled } from '@/entrypoints/content/core/status';
import { applyInitialVideoStyling, removeInitialVideoStyling } from '@/entrypoints/content/presentation/initialStyling';
import { queueThumbnailForInference } from '@/entrypoints/content/video/thumbnail';

import type { IHostSettings } from '@/utils/types';

/**
 * Handle video elements for thumbnail processing:
 * - Apply initial styling on first encounter
 * - Queue thumbnail for immediate inference
 */
export function handleVideos(videos: HTMLVideoElement[], hostSettings: IHostSettings): void {
  for (const video of videos) {
    const src = video.currentSrc || video.src;
    if (!src) continue;

    // Apply initial styling and mark as handled
    if (!isHandled(video, src)) {
      applyInitialVideoStyling(video, hostSettings);
      markHandled(video, src);
      queueThumbnailForInference(video, src, hostSettings);
    }
  }
}

/**
 * Handle video attribute changes (e.g., src changed)
 */
export function handleVideoAttributeChange(video: HTMLVideoElement, hostSettings: IHostSettings): void {
  const currentSrc = video.currentSrc || video.src;
  if (video.dataset.hbSrc && video.dataset.hbSrc !== currentSrc) {
    // Clear all tracking when src changes
    removeInitialVideoStyling(video);
    delete video.dataset.hbHandled;
    delete video.dataset.hbSent;
    delete video.dataset.hbProcessed;
    delete video.dataset.hbThumbnailSent;
    delete video.dataset.hbThumbnailProcessed;
    delete video.dataset.hbFrameCount;
    video.dataset.hbSrc = currentSrc;
  }
  handleVideos([video], hostSettings);
}

/**
 * Dispose video session and cleanup
 */
export function disposeVideoSession(video: HTMLVideoElement): void {
  removeInitialVideoStyling(video);
}
