import { describe, expect, it } from 'vitest';

import {
  VerdictTimeline,
  type VerdictEntry,
  MAX_TIMELINE_ENTRIES,
} from '@/entrypoints/content/video/timeline/verdictTimeline';

function entry(timestampSec: number, unsafe: boolean): VerdictEntry {
  return {
    timestampSec,
    unsafe,
    predictions: [],
    maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    width: 640,
    height: 360,
  };
}

describe('VerdictTimeline', () => {
  it('bounds session-lifetime growth by dropping the oldest entries', () => {
    const timeline = new VerdictTimeline();
    for (let i = 0; i < MAX_TIMELINE_ENTRIES + 10; i++) timeline.add(entry(i * 0.25, false));

    expect(timeline.size()).toBe(MAX_TIMELINE_ENTRIES);
    expect(timeline.at(0)?.timestampSec).toBe(2.5);
  });

  it('reports continuous coverage ahead of a position', () => {
    const timeline = new VerdictTimeline();
    for (const t of [1, 1.5, 2, 2.5, 3]) timeline.add(entry(t, false));

    expect(timeline.coverageAheadOf(1.2, undefined, 1)).toBeCloseTo(1.8);
    expect(timeline.coverageAheadOf(3.5, undefined, 1)).toBe(0);
    expect(timeline.coverageAheadOf(10, undefined, 1)).toBe(0);
  });

  it('coverage stops at a gap larger than the tolerance', () => {
    const timeline = new VerdictTimeline();
    for (const t of [1, 1.5, 2, 5, 5.5]) timeline.add(entry(t, false));

    expect(timeline.coverageAheadOf(1.2, undefined, 1)).toBeCloseTo(0.8);
    expect(timeline.coverageAheadOf(4.8, undefined, 1)).toBeCloseTo(0.7);
  });

  it('coverage survives seeks: verdicts recorded earlier answer for a re-visited range', () => {
    const timeline = new VerdictTimeline();
    for (const t of [10, 10.5, 11, 11.5, 12]) timeline.add(entry(t, false));

    expect(timeline.coverageAheadOf(10, undefined, 1)).toBeCloseTo(2);
  });
});

describe('VerdictTimeline coverage to the media end', () => {
  const analysedClip = (durationSec: number) => {
    const timeline = new VerdictTimeline();
    for (let t = 0; t < durationSec; t += 0.5) timeline.add(entry(t, false));
    return timeline;
  };

  it('covers everything that will play once coverage reaches the end of a non-looping video', () => {
    const timeline = analysedClip(3);

    expect(timeline.coverageAheadOf(0.2, { durationSec: 3, loops: false })).toBe(Number.POSITIVE_INFINITY);
  });

  it('still reports the remaining coverage when it stops short of the end', () => {
    const timeline = new VerdictTimeline();
    for (const t of [0, 0.5, 1, 1.5, 2]) timeline.add(entry(t, false));

    expect(timeline.coverageAheadOf(0.2, { durationSec: 30, loops: false })).toBeCloseTo(1.8);
  });

  it('wraps past the loop point into coverage at the start of the clip', () => {
    const timeline = new VerdictTimeline();
    for (const t of [0, 0.5, 1, 1.5, 2, 18, 18.5, 19, 19.5]) timeline.add(entry(t, false));

    expect(timeline.coverageAheadOf(18.5, { durationSec: 20, loops: true })).toBeCloseTo(3.5);
  });

  it('covers a fully analysed loop forever', () => {
    const timeline = analysedClip(10);

    expect(timeline.coverageAheadOf(9, { durationSec: 10, loops: true })).toBe(Number.POSITIVE_INFINITY);
  });

  it('ignores the end of a live or unknown-duration stream', () => {
    const timeline = analysedClip(3);

    expect(timeline.coverageAheadOf(0.2, { durationSec: Number.POSITIVE_INFINITY, loops: false })).toBeCloseTo(2.3);
    expect(timeline.coverageAheadOf(0.2, { durationSec: Number.NaN, loops: true })).toBeCloseTo(2.3);
  });
});

describe('VerdictTimeline samples at the same media time', () => {
  it('keeps the unsafe one, whichever arrives first', () => {
    const unsafeFirst = new VerdictTimeline();
    unsafeFirst.add(entry(1, true));
    unsafeFirst.add(entry(1, false));
    const cleanFirst = new VerdictTimeline();
    cleanFirst.add(entry(1, false));
    cleanFirst.add(entry(1, true));

    expect([unsafeFirst.size(), unsafeFirst.at(0)?.unsafe]).toEqual([1, true]);
    expect([cleanFirst.size(), cleanFirst.at(0)?.unsafe]).toEqual([1, true]);
  });
});
