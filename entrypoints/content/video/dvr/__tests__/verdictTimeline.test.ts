import { describe, expect, it } from 'vitest';

import {
  VerdictTimeline,
  type VerdictEntry,
  MAX_TIMELINE_ENTRIES,
} from '@/entrypoints/content/video/dvr/verdictTimeline';

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

    // Mid-range: covered up to the last chained verdict.
    expect(timeline.coverageAheadOf(1.2, 1)).toBeCloseTo(1.8);
    // Past the last verdict: nothing ahead.
    expect(timeline.coverageAheadOf(3.5, 1)).toBe(0);
    // Far from any verdict: uncovered.
    expect(timeline.coverageAheadOf(10, 1)).toBe(0);
  });

  it('coverage stops at a gap larger than the tolerance', () => {
    const timeline = new VerdictTimeline();
    for (const t of [1, 1.5, 2, 5, 5.5]) timeline.add(entry(t, false));

    // The 2→5 gap breaks the chain even though later verdicts exist.
    expect(timeline.coverageAheadOf(1.2, 1)).toBeCloseTo(0.8);
    // Starting inside the later cluster sees only that cluster.
    expect(timeline.coverageAheadOf(4.8, 1)).toBeCloseTo(0.7);
  });

  it('coverage survives seeks: verdicts recorded earlier answer for a re-visited range', () => {
    const timeline = new VerdictTimeline();
    for (const t of [10, 10.5, 11, 11.5, 12]) timeline.add(entry(t, false));

    // A seek back to 10 finds the watched range still covered.
    expect(timeline.coverageAheadOf(10, 1)).toBeCloseTo(2);
  });
});

describe('VerdictTimeline cache seeding', () => {
  it('seeds cached entries and derives unsafe from predictions', () => {
    const track = new VerdictTimeline();
    track.add(entry(1, false));
    track.seed([
      {
        timestampSec: 2,
        predictions: [{} as never],
        input: { width: 1, height: 1, maskTransform: entry(0, false).maskTransform },
      },
      {
        timestampSec: 0.5,
        predictions: [],
        input: { width: 1, height: 1, maskTransform: entry(0, false).maskTransform },
      },
    ]);
    expect(track.size()).toBe(3);
    expect(track.cachedVerdictAt(2.1)?.unsafe).toBe(true);
    expect(track.coverageAheadOf(0.5)).toBe(1.5);
  });

  it('keeps live entries over cached ones with the same timestamp', () => {
    const track = new VerdictTimeline();
    track.add(entry(1, true));
    track.seed([cachedEntry(1, false)]);
    expect(track.size()).toBe(1);
    expect(track.at(0)?.unsafe).toBe(true);
    expect(track.cachedVerdictAt(1)).toBeNull();
  });

  it('answers only from seeded entries, never from live verdicts', () => {
    const track = new VerdictTimeline();
    track.add(entry(1, false));
    expect(track.cachedVerdictAt(1.1)).toBeNull();
    track.seed([cachedEntry(1.2, true)]);
    expect(track.cachedVerdictAt(1.1)?.timestampSec).toBe(1.2);
  });

  it('answers the nearest seeded verdict within the cached gap and null outside it', () => {
    const track = new VerdictTimeline();
    track.seed([cachedEntry(1, false), cachedEntry(1.3, true)]);
    expect(track.cachedVerdictAt(1.1)?.timestampSec).toBe(1);
    expect(track.cachedVerdictAt(1.2)?.timestampSec).toBe(1.3);
    expect(track.cachedVerdictAt(1.5)?.timestampSec).toBe(1.3);
    expect(track.cachedVerdictAt(2)).toBeNull();
    expect(new VerdictTimeline().cachedVerdictAt(0)).toBeNull();
  });
});

describe('VerdictTimeline cached entry hygiene', () => {
  it('treats cached timestamps within a millisecond of a live entry as the same frame', () => {
    const track = new VerdictTimeline();
    track.add(entry(0.2, false));
    const seeded = track.seed([cachedEntry(0.2000001, true), cachedEntry(0.5, true)]);
    expect(seeded.map(e => e.timestampSec)).toEqual([0.5]);
    expect(track.size()).toBe(2);
  });

  it('drops seeded entries and keeps live ones', () => {
    const track = new VerdictTimeline();
    track.add(entry(1, false));
    track.seed([cachedEntry(2, true)]);
    track.dropCached();
    expect(track.size()).toBe(1);
    expect(track.cachedVerdictAt(2)).toBeNull();
  });
});

function cachedEntry(timestampSec: number, unsafe: boolean) {
  return {
    timestampSec,
    predictions: unsafe ? [{} as never] : [],
    input: { width: 1, height: 1, maskTransform: entry(0, false).maskTransform },
  };
}
