/**
 * Drain clock for the DVR tail (docs/VIDEO_PROCESSING.md). After `ended` the
 * media clock stops advancing, so the presenter can no longer derive its
 * position from `video.currentTime − D`: the drain clock advances the
 * presented media time at 1x wall rate from where the presentation froze
 * until the newest buffered frame, where it pins — the ending plays out at
 * normal speed and holds its final frame instead of being cut off.
 */

export interface DrainClock {
  /** Presented media time at the moment the drain began. */
  readonly startMediaTime: number;
  /** Wall clock (seconds) at the moment the drain began. */
  readonly startWallSec: number;
}

export function startDrainClock(presentedMediaTime: number, nowWallSec: number): DrainClock {
  return { startMediaTime: presentedMediaTime, startWallSec: nowWallSec };
}

/** Presented media time for a draining DVR: 1x wall rate, pinned at the newest buffered frame. */
export function drainTargetTime(clock: DrainClock, nowWallSec: number, newestMediaTime: number): number {
  return Math.min(clock.startMediaTime + Math.max(0, nowWallSec - clock.startWallSec), newestMediaTime);
}
