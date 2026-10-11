import { foldToMediaTime } from '@/entrypoints/content/video/loopClock';

export const MAX_EXTRAPOLATION_SEC = 0.1;

/**
 * Snapshot of the media element's clock state the presentation clock extrapolates from.
 */
export interface MediaClockReading {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  duration: number;
  loop: boolean;
}

/**
 * Estimates the media time of the frame on screen between the element's coarse `currentTime`
 * updates, so masks track the playhead every rAF.
 */
export interface PresentationClock {
  timeAt(media: MediaClockReading, nowMs: number): number;
}

export function createPresentationClock(): PresentationClock {
  let lastSeenTime = Number.NaN;
  let lastChangeSeenAtMs = 0;
  return {
    timeAt(media, nowMs) {
      if (media.currentTime !== lastSeenTime) {
        lastSeenTime = media.currentTime;
        lastChangeSeenAtMs = nowMs;
      }
      if (media.paused) return media.currentTime;
      const elapsedSec = Math.min((nowMs - lastChangeSeenAtMs) / 1000, MAX_EXTRAPOLATION_SEC);
      const extrapolated = media.currentTime + elapsedSec * media.playbackRate;
      return media.loop ? foldToMediaTime(extrapolated, media.duration) : extrapolated;
    },
  };
}
