import { isHandled, markHandled } from '@/entrypoints/content/core/status';
import { clearBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { applyInitialVideoStyling, resetVideoStyling } from '@/entrypoints/content/presentation/initialStyling';
import { videoMaskOverlays } from '@/entrypoints/content/presentation/videoMaskOverlay';
import { releaseCorsVideoCache } from '@/entrypoints/content/video/frameCapture';
import { handleVideoPlayback, releaseVideoPlayback } from '@/entrypoints/content/video/playback';
import { queueThumbnailForInference } from '@/entrypoints/content/video/thumbnail';
import { DEFAULT_VIDEO_CONFIG } from '@/utils/constants/video';

import type { IHostSettings } from '@/utils/types';

/**
 * Track play event listeners for cleanup
 */
const playbackListeners = new WeakMap<HTMLVideoElement, () => void>();

/**
 * Handle video elements for processing
 * - Apply initial styling on first encounter
 * - Queue thumbnail for immediate inference
 * - Set up playback handler
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
    // Set up playback handler (only for 'process' policy which includes video)
    if (hostSettings.policy === 'process') {
      ensurePlaybackHandler(video, hostSettings);
    }
  }
}

/**
 * Handle video attribute changes (e.g., src changed)
 */
export function handleVideoAttributeChange(video: HTMLVideoElement, hostSettings: IHostSettings): void {
  const currentSrc = video.currentSrc || video.src;
  if (video.dataset.hbSrc && video.dataset.hbSrc !== currentSrc) {
    // Clear all tracking and overlays when src changes
    videoMaskOverlays.clearMaskOverlay(video);
    clearBlurBoxOverlay(video);
    resetVideoStyling(video);
    releaseVideoPlayback(video);
    releaseCorsVideoCache(video);
    cleanupPlaybackListener(video);
    delete video.dataset.hbHandled;
    delete video.dataset.hbSent;
    delete video.dataset.hbProcessed;
    delete video.dataset.hbThumbnailSent;
    delete video.dataset.hbThumbnailProcessed;
    delete video.dataset.hbFrameCount;
    delete video.dataset.hbSessionId;
    video.dataset.hbSrc = currentSrc;
  }
  handleVideos([video], hostSettings);
}

/**
 * Set up playback handler (deferred until play event)
 */
function ensurePlaybackHandler(video: HTMLVideoElement, hostSettings: IHostSettings): void {
  if (playbackListeners.has(video)) {
    return; // Already set up
  }

  const onPlay = () => {
    handleVideoPlayback(video, hostSettings, DEFAULT_VIDEO_CONFIG);
  };

  video.addEventListener('play', onPlay);
  playbackListeners.set(video, onPlay);

  // If video is already playing, start handling immediately
  if (!video.paused && !video.ended) {
    onPlay();
  }
}

/**
 * Cleanup play event listener
 */
function cleanupPlaybackListener(video: HTMLVideoElement): void {
  const listener = playbackListeners.get(video);
  if (listener) {
    video.removeEventListener('play', listener);
    playbackListeners.delete(video);
  }
}

/**
 * Dispose video session and cleanup
 */
export function disposeVideoSession(video: HTMLVideoElement): void {
  videoMaskOverlays.clearMaskOverlay(video);
  clearBlurBoxOverlay(video);
  cleanupPlaybackListener(video);
  releaseVideoPlayback(video);
  releaseCorsVideoCache(video);
}
