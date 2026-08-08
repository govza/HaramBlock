/**
 * Drain frame-selection at the DVR unit seam: after `ended` the media clock
 * stops, so the presenter advances its own presented position at 1x wall rate
 * through the buffered tail and pins on the newest frame (the held ending).
 */
import { describe, expect, it } from 'vitest';

import { drainTargetTime, startDrainClock } from '@/entrypoints/content/video/dvr/drain';
import { FrameRing } from '@/entrypoints/content/video/dvr/frameRing';

const FRAME = { width: 640, height: 360, close: () => {} };

describe('DVR drain', () => {
  it('advances the presented mediaTime at 1x wall rate to the newest frame, then pins', () => {
    // Buffered tail: frames every 1/30 s up to the end of the media at 30 s.
    const ring = new FrameRing<typeof FRAME>(5, 64 * 1024 * 1024);
    for (let mediaTime = 26; mediaTime <= 30.001; mediaTime += 1 / 30) {
      ring.push({ bitmap: FRAME, mediaTime });
    }
    const newest = ring.newestTime();
    expect(newest).not.toBeNull();

    // Media clock stopped at 30 with D = 1.5: the presentation froze at 28.5.
    const frozenMediaTime = 28.5;
    const clock = startDrainClock(frozenMediaTime, 100);

    // The presented clock now runs on wall time, 1x.
    const presented: number[] = [];
    for (let wallSec = 100; wallSec <= 103; wallSec += 1 / 60) {
      const target = drainTargetTime(clock, wallSec, newest ?? 0);
      const frame = ring.frameAt(target);
      if (frame) presented.push(frame.mediaTime);
    }
    expect(presented[0]).toBeCloseTo(frozenMediaTime, 1);
    const oneSecondIn = drainTargetTime(clock, 101, newest ?? 0);
    expect(oneSecondIn).toBeCloseTo(29.5, 5);

    // Past the tail, the target pins on the newest frame — the held ending.
    expect(drainTargetTime(clock, 102.5, newest ?? 0)).toBe(newest);
    expect(presented.at(-1)).toBe(newest);
    // Every buffered frame in the tail was presented on the way there.
    const distinct = new Set(presented);
    expect(distinct.size).toBeGreaterThanOrEqual(Math.floor((30 - frozenMediaTime) * 24));
  });

  it('never runs the presented clock backwards on a wall-clock hiccup', () => {
    const clock = startDrainClock(10, 50);
    expect(drainTargetTime(clock, 49.9, 20)).toBe(10);
  });
});
