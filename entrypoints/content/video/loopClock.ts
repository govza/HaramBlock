export interface LoopingMedia {
  duration(): number;
  loops(): boolean;
}

export interface LoopRestartMedia extends LoopingMedia {
  playbackRate(): number;
}

export const loopingMediaOf = (video: HTMLVideoElement): LoopRestartMedia => ({
  duration: () => video.duration,
  loops: () => video.loop,
  playbackRate: () => video.playbackRate,
});

export type LoopUnwrapper = (mediaTime: number) => number;

export interface PlaybackClock {
  continuousTime(): number;
  foldToMediaTime(continuousTime: number): number;
}

const hasFiniteDuration = (duration: number): boolean => Number.isFinite(duration) && duration > 0;

const STALE_READING_TOLERANCE_SEC = 0.5;

const loopOffsetNotBefore = (mediaTime: number, referenceTime: number, duration: number): number => {
  const earliestTime = referenceTime - Math.min(STALE_READING_TOLERANCE_SEC, duration / 2);
  return Math.ceil((earliestTime - mediaTime) / duration) * duration;
};

export function createLoopUnwrapper(media: LoopingMedia): LoopUnwrapper {
  let loopOffsetSec = 0;
  let lastContinuousTime: number | null = null;
  return mediaTime => {
    const duration = media.duration();
    if (lastContinuousTime !== null && media.loops() && hasFiniteDuration(duration)) {
      loopOffsetSec = loopOffsetNotBefore(mediaTime, lastContinuousTime, duration);
    }
    lastContinuousTime = mediaTime + loopOffsetSec;
    return lastContinuousTime;
  };
}

export function foldToMediaTime(continuousTime: number, duration: number): number {
  if (!hasFiniteDuration(duration) || (continuousTime >= 0 && continuousTime < duration)) return continuousTime;
  return continuousTime - Math.floor(continuousTime / duration) * duration;
}

export function isLoopWrap(media: LoopingMedia, previousTime: number | null, currentTime: number): boolean {
  const duration = media.duration();
  return (
    previousTime !== null && media.loops() && hasFiniteDuration(duration) && previousTime - currentTime > duration / 2
  );
}

const LOOP_RESTART_EDGE_SEC = 0.5;

const loopRestartEdgeSec = (media: LoopRestartMedia): number =>
  LOOP_RESTART_EDGE_SEC * Math.max(1, media.playbackRate());

export function isLoopRestartSeek(media: LoopRestartMedia, previousTime: number | null, currentTime: number): boolean {
  const edgeSec = loopRestartEdgeSec(media);
  return (
    previousTime !== null &&
    isLoopWrap(media, previousTime, currentTime) &&
    media.duration() - previousTime <= edgeSec &&
    currentTime <= edgeSec
  );
}

export interface LoopRestartDetector {
  observePlayback(currentTime: number, seeking: boolean): void;
  isLoopRestart(currentTime: number): boolean;
  reset(): void;
}

export function createLoopRestartDetector(media: LoopRestartMedia): LoopRestartDetector {
  let lastPlaybackPosition: number | null = null;
  return {
    observePlayback(currentTime, seeking) {
      if (seeking || isLoopWrap(media, lastPlaybackPosition, currentTime)) return;
      lastPlaybackPosition = currentTime;
    },
    isLoopRestart(currentTime) {
      const loopRestart = isLoopRestartSeek(media, lastPlaybackPosition, currentTime);
      lastPlaybackPosition = currentTime;
      return loopRestart;
    },
    reset() {
      lastPlaybackPosition = null;
    },
  };
}
