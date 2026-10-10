import { describe, expect, it } from 'vitest';

import {
  createLoopRestartDetector,
  isLoopRestartSeek,
  isLoopWrap,
  type LoopRestartMedia,
} from '@/entrypoints/content/video/loopClock';

const looping = (duration: number, loops = true, playbackRate = 1): LoopRestartMedia => ({
  duration: () => duration,
  loops: () => loops,
  playbackRate: () => playbackRate,
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

  it('widens the edges with playback rate, since timeupdate reports the tail less often in media time', () => {
    expect(isLoopRestartSeek(looping(30, true, 1), 29.1, 0.02)).toBe(false);
    expect(isLoopRestartSeek(looping(30, true, 4), 29.1, 0.02)).toBe(true);
    expect(isLoopRestartSeek(looping(30, true, 4), 20, 0.02)).toBe(false);
  });

  it('never narrows the edges below their real-time width when slowed down', () => {
    expect(isLoopRestartSeek(looping(10, true, 0.25), 9.8, 0.02)).toBe(true);
  });
});

describe('createLoopRestartDetector', () => {
  it('classifies a native restart whose head-of-loop timeupdate lands before seeked', () => {
    const detector = createLoopRestartDetector(looping(2.5));
    detector.observePlayback(2.3, false);
    detector.observePlayback(2.45, false);
    detector.observePlayback(0.0001, false);
    expect(detector.isLoopRestart(0)).toBe(true);
  });

  it('keeps classifying restarts loop after loop', () => {
    const detector = createLoopRestartDetector(looping(2.5));
    for (let loop = 0; loop < 3; loop++) {
      detector.observePlayback(1.2, false);
      detector.observePlayback(2.4, false);
      detector.observePlayback(0.0001, false);
      expect(detector.isLoopRestart(0)).toBe(true);
    }
  });

  it('treats a user seek back to the start from mid-clip as a real seek', () => {
    const detector = createLoopRestartDetector(looping(10));
    detector.observePlayback(7, false);
    detector.observePlayback(0, true);
    expect(detector.isLoopRestart(0)).toBe(false);
  });

  it('ignores positions reported while a seek is in progress', () => {
    const detector = createLoopRestartDetector(looping(10));
    detector.observePlayback(9.8, false);
    detector.observePlayback(4, true);
    expect(detector.isLoopRestart(0.02)).toBe(true);
  });

  it('classifies a fast-forwarded restart whose last tail timeupdate is a second before the end', () => {
    const detector = createLoopRestartDetector(looping(30, true, 4));
    detector.observePlayback(28.1, false);
    detector.observePlayback(29.1, false);
    detector.observePlayback(0.0001, false);
    expect(detector.isLoopRestart(0)).toBe(true);
  });

  it('forgets the playback position after a reset', () => {
    const detector = createLoopRestartDetector(looping(2.5));
    detector.observePlayback(2.4, false);
    detector.reset();
    expect(detector.isLoopRestart(0)).toBe(false);
  });
});
