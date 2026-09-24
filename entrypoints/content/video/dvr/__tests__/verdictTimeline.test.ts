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
