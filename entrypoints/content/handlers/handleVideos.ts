import { applyBlacklistStyling, hasBlacklistStyling } from '@/entrypoints/content/presentation/initialStyling';
import { videoSessions } from '@/entrypoints/content/video/session/registry';

import type { IHostSettings } from '@/utils/types';

/**
 * Route discovered video elements into the VideoSession pipeline.
 * - Blacklist policy: mask outright, no inference.
 * - Otherwise adopt: the registry itself waits out videos with no resolved
 *   source yet (<source> children, MSE, late src assignment), so re-discovery
 *   always refreshes host settings and pipeline teardown cancels the wait.
 */
export function handleVideos(videos: HTMLVideoElement[], hostSettings: IHostSettings): void {
  const isBlacklist = hostSettings.policy.behavior === 'blacklist';

  for (const video of videos) {
    if (isBlacklist) {
      if (!hasBlacklistStyling(video)) {
        applyBlacklistStyling(video, hostSettings);
      }
      continue;
    }

    videoSessions.adopt(video, hostSettings);
  }
}

/**
 * Handle video attribute changes (e.g., src changed). The registry itself
 * re-adopts on source changes via 'loadstart'; this covers attribute mutations
 * observed before any media event fires.
 */
export function handleVideoAttributeChange(video: HTMLVideoElement, hostSettings: IHostSettings): void {
  handleVideos([video], hostSettings);
}

/** Dispose the VideoSession for a removed element. */
export function disposeVideoSession(video: HTMLVideoElement): void {
  videoSessions.dispose(video);
}
