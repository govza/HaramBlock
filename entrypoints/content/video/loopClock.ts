export interface LoopingMedia {
  duration(): number;
  loops(): boolean;
}

export const loopingMediaOf = (video: HTMLVideoElement): LoopingMedia => ({
  duration: () => video.duration,
  loops: () => video.loop,
});

export type LoopUnwrapper = (mediaTime: number) => number;

export interface PlaybackClock {
  continuousTime(): number;
  foldToMediaTime(continuousTime: number): number;
}

const hasFiniteDuration = (duration: number): boolean => Number.isFinite(duration) && duration > 0;

export function createLoopUnwrapper(media: LoopingMedia): LoopUnwrapper {
  let loopOffsetSec = 0;
  let lastMediaTime: number | null = null;
  return mediaTime => {
    if (isLoopWrap(media, lastMediaTime, mediaTime)) loopOffsetSec += media.duration();
    lastMediaTime = mediaTime;
    return mediaTime + loopOffsetSec;
  };
}

export function foldToMediaTime(continuousTime: number, duration: number): number {
  if (!hasFiniteDuration(duration) || continuousTime < duration) return continuousTime;
  return continuousTime - Math.floor(continuousTime / duration) * duration;
}

export function isLoopWrap(media: LoopingMedia, previousTime: number | null, currentTime: number): boolean {
  const duration = media.duration();
  return (
    previousTime !== null && media.loops() && hasFiniteDuration(duration) && previousTime - currentTime > duration / 2
  );
}

const LOOP_RESTART_EDGE_SEC = 0.5;

export function isLoopRestartSeek(media: LoopingMedia, previousTime: number | null, currentTime: number): boolean {
  return (
    previousTime !== null &&
    isLoopWrap(media, previousTime, currentTime) &&
    media.duration() - previousTime <= LOOP_RESTART_EDGE_SEC &&
    currentTime <= LOOP_RESTART_EDGE_SEC
  );
}

export interface LoopRestartDetector {
  observePlayback(currentTime: number, seeking: boolean): void;
  isLoopRestart(currentTime: number): boolean;
  reset(): void;
}

export function createLoopRestartDetector(media: LoopingMedia): LoopRestartDetector {
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
