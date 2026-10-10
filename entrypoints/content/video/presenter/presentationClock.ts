import { foldToMediaTime } from '@/entrypoints/content/video/loopClock';

export const MAX_EXTRAPOLATION_SEC = 0.1;

export interface MediaClockReading {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  duration: number;
  loop: boolean;
}

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
