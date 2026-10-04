export interface LoopingMedia {
  duration(): number;
  loops(): boolean;
}

export interface LoopUnwrapper {
  unwrap: (mediaTime: number) => number;
}

const hasFiniteDuration = (duration: number): boolean => Number.isFinite(duration) && duration > 0;

export function createLoopUnwrapper(media: LoopingMedia): LoopUnwrapper {
  let loopOffsetSec = 0;
  let lastMediaTime: number | null = null;
  return {
    unwrap: mediaTime => {
      if (isLoopWrap(media, lastMediaTime, mediaTime)) loopOffsetSec += media.duration();
      lastMediaTime = mediaTime;
      return mediaTime + loopOffsetSec;
    },
  };
}

export function foldLoopedMediaTime(mediaTime: number, duration: number): number {
  if (!hasFiniteDuration(duration) || mediaTime < duration) return mediaTime;
  return mediaTime - Math.floor(mediaTime / duration) * duration;
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
