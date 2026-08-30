import { applyBlacklistStyling, hasBlacklistStyling } from '@/entrypoints/content/presentation/initialStyling';
import { markVideoDiscovered } from '@/entrypoints/content/presentation/styleInjecting';
import { videoSessions } from '@/entrypoints/content/video/session/registry';

import type { FrameInferenceResult, IHostSettings } from '@/utils/types';

/**
 * Routes discovered video elements into the VideoSession pipeline; the video
 * sibling of ImageProcessor.
 * - Blacklist policy: mask outright, no inference.
 * - Otherwise adopt: the registry itself waits out videos with no resolved
 *   source yet (<source> children, MSE, late src assignment), so re-discovery
 *   always refreshes host settings and pipeline teardown cancels the wait.
 */
export class VideoProcessor {
  constructor(private readonly hostSettings: IHostSettings) {}

  processAll(videos: HTMLVideoElement[]): void {
    const isBlacklist = this.hostSettings.policy.behavior === 'blacklist';

    for (const video of videos) {
      if (isBlacklist) {
        if (!hasBlacklistStyling(video)) {
          applyBlacklistStyling(video, this.hostSettings);
        }
        markVideoDiscovered(video);
        continue;
      }

      videoSessions.adopt(video, this.hostSettings);
      // adopt() synchronously applies either the VideoSession adoption blur or
      // the unresolved-source pending blur. Only now may bootstrap hiding lift.
      markVideoDiscovered(video);
    }
  }

  /**
   * The registry itself re-adopts on source changes via 'loadstart'; this
   * covers attribute mutations observed before any media event fires.
   */
  handleSrcChange(video: HTMLVideoElement): void {
    this.processAll([video]);
  }

  handleRemoved(video: HTMLVideoElement): void {
    videoSessions.dispose(video);
  }

  handleInferenceResults(results: FrameInferenceResult[]): void {
    if (!results || results.length === 0) return;
    videoSessions.handleResults(results);
  }

  dispose(): void {
    videoSessions.disposeAll();
  }
}
