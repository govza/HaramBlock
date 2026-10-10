import { describe, expect, it } from 'vitest';

import { createPresentationClock } from '@/entrypoints/content/video/presenter/presentationClock';

const media = (
  currentTime: number,
  overrides: Partial<{ paused: boolean; playbackRate: number; duration: number; loop: boolean }> = {},
) => ({
  currentTime,
  paused: false,
  playbackRate: 1,
  duration: 60,
  loop: false,
  ...overrides,
});

describe('presentation clock', () => {
  it('extrapolates currentTime from the moment its value last changed', () => {
    const clock = createPresentationClock();
    expect(clock.timeAt(media(10), 1_000)).toBe(10);
    expect(clock.timeAt(media(10), 1_040)).toBeCloseTo(10.04);
  });

  it('caps the extrapolation at 100 ms', () => {
    const clock = createPresentationClock();
    clock.timeAt(media(10), 1_000);
    expect(clock.timeAt(media(10), 1_500)).toBeCloseTo(10.1);
  });

  it('scales the extrapolation by the playback rate', () => {
    const clock = createPresentationClock();
    clock.timeAt(media(10, { playbackRate: 2 }), 1_000);
    expect(clock.timeAt(media(10, { playbackRate: 2 }), 1_050)).toBeCloseTo(10.1);
  });

  it('restarts the extrapolation when currentTime moves', () => {
    const clock = createPresentationClock();
    clock.timeAt(media(10), 1_000);
    expect(clock.timeAt(media(10.25), 1_300)).toBe(10.25);
  });

  it('does not extrapolate a paused video', () => {
    const clock = createPresentationClock();
    clock.timeAt(media(10, { paused: true }), 1_000);
    expect(clock.timeAt(media(10, { paused: true }), 1_080)).toBe(10);
  });

  it('folds a looping video back into its duration', () => {
    const clock = createPresentationClock();
    clock.timeAt(media(9.97, { loop: true, duration: 10 }), 1_000);
    expect(clock.timeAt(media(9.97, { loop: true, duration: 10 }), 1_080)).toBeCloseTo(0.05);
  });
});
