import { describe, expect, it } from 'vitest';

import {
  createLoopUnwrapper,
  isLoopRestartSeek,
  isLoopWrap,
  type LoopingMedia,
} from '@/entrypoints/content/video/loopClock';

const looping = (duration: number, loops = true): LoopingMedia => ({ duration: () => duration, loops: () => loops });

describe('createLoopUnwrapper', () => {
  it('passes media time through until the clip wraps', () => {
    const clock = createLoopUnwrapper(looping(2.5));
    expect([0, 0.1, 1.2, 2.4].map(clock)).toEqual([0, 0.1, 1.2, 2.4]);
  });

  it('continues the timeline across every native loop wrap', () => {
    const clock = createLoopUnwrapper(looping(2.5));
    const keys = [2.3, 2.4, 0, 0.1, 2.4, 0.05].map(clock);
    expect(keys[2]).toBeCloseTo(2.5, 9);
    expect(keys[3]).toBeCloseTo(2.6, 9);
    expect(keys[4]).toBeCloseTo(4.9, 9);
    expect(keys[5]).toBeCloseTo(5.05, 9);
  });

  it('keeps a late frame from the previous loop on its own loop', () => {
    const clock = createLoopUnwrapper(looping(2.5));
    clock(2.3);
    expect(clock(2.4)).toBeCloseTo(2.4, 9);
    expect(clock(0.02)).toBeCloseTo(2.52, 9);
  });

  it('leaves small backsteps alone (re-delivered stale frames, not wraps)', () => {
    const clock = createLoopUnwrapper(looping(10));
    clock(5);
    expect(clock(4.96)).toBe(4.96);
  });

  it('never unwraps a non-looping or unbounded video', () => {
    const plain = createLoopUnwrapper(looping(2.5, false));
    plain(2.4);
    expect(plain(0)).toBe(0);
    const live = createLoopUnwrapper(looping(Number.POSITIVE_INFINITY));
    live(100);
    expect(live(1)).toBe(1);
  });
});

describe('isLoopWrap', () => {
  it('recognizes a looping clip jumping from its tail to its head', () => {
    expect(isLoopWrap(looping(2.5), 2.4, 0.01)).toBe(true);
  });

  it('rejects ordinary seeks and non-looping videos', () => {
    expect(isLoopWrap(looping(60), 30, 25)).toBe(false);
    expect(isLoopWrap(looping(2.5, false), 2.4, 0)).toBe(false);
    expect(isLoopWrap(looping(2.5), null, 0)).toBe(false);
  });
});

describe('isLoopRestartSeek', () => {
  it('accepts a native restart from the tail edge to the head edge', () => {
    expect(isLoopRestartSeek(looping(10), 9.8, 0.02)).toBe(true);
  });

  it('rejects a user seek back to the start from mid-clip', () => {
    expect(isLoopRestartSeek(looping(10), 7, 0)).toBe(false);
    expect(isLoopRestartSeek(looping(10), 9.8, 2)).toBe(false);
  });
});
