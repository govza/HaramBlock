import { describe, expect, it } from 'vitest';

import {
  BRIDGE_HORIZON_SEC,
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
  it('covers every frame with the closest verdict behind it', () => {
    const track = new VerdictTimeline();
    const unsafe = entry(2, true);
    track.add(entry(1, false));
    track.add(unsafe);

    expect(track.verdictFor(1.1)).toEqual({ kind: 'clean' });
    // A mask starts exactly at its unsafe sample: no pre-masking before it.
    expect(track.verdictFor(1.6)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(2 + BRIDGE_HORIZON_SEC + 0.1)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('cuts the mask at a clean verdict confirmed by a following clean verdict', () => {
    const track = new VerdictTimeline();
    const unsafe = entry(10, true);
    track.add(unsafe);
    track.add(entry(10.5, false));
    track.add(entry(11, false));

    // Masked from the unsafe sample right up to the clean sample…
    expect(track.verdictFor(10.4)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    // …then cut: the clean verdict is confirmed by the one after it.
    expect(track.verdictFor(10.6)).toEqual({ kind: 'clean' });
  });

  it('holds the mask over an unconfirmed clean verdict (no following verdict yet)', () => {
    const track = new VerdictTimeline();
    const unsafe = entry(10, true);
    track.add(unsafe);
    track.add(entry(10.5, false));

    expect(track.verdictFor(10.6)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('does not trust a lone clean verdict between two unsafe ones', () => {
    const track = new VerdictTimeline();
    const a = entry(10, true);
    const b = entry(11, true);
    track.add(a);
    track.add(entry(10.5, false));
    track.add(b);

    expect(track.verdictFor(10.6)).toEqual({ kind: 'unsafe', entries: [a, b] });
  });

  it('bridges coverage holes instead of blurring between masked stretches', () => {
    const track = new VerdictTimeline();
    track.add(entry(1, true));
    const last = entry(3.5, true); // 2.5s hole: an inference-latency spike
    track.add(last);

    const bridged = track.verdictFor(2.2);
    expect(bridged.kind).toBe('unsafe');

    expect(track.verdictFor(3.5 + 0.9).kind).toBe('unsafe');
    expect(track.verdictFor(3.5 + 10)).toEqual({ kind: 'unsafe', entries: [last] });

    // A hole between two clean verdicts presents clean.
    const cleanTrack = new VerdictTimeline();
    cleanTrack.add(entry(1, false));
    cleanTrack.add(entry(3.5, false));
    expect(cleanTrack.verdictFor(2.2)).toEqual({ kind: 'clean' });

    expect(cleanTrack.verdictFor(3.5 + 0.9)).toEqual({ kind: 'clean' });
    expect(cleanTrack.verdictFor(3.5 + 10)).toEqual({ kind: 'clean' });
  });

  it('masks the whole span from an unsafe sample to the next clean verdict', () => {
    const track = new VerdictTimeline();
    track.add(entry(10, true));
    track.add(entry(12, false)); // inference stalled, then came back clean

    // The mask holds across the hole right up to the clean sample — the
    // frames in between have no verdict, and a mask is the fail-closed cover.
    expect(track.verdictFor(10.5).kind).toBe('unsafe');
    expect(track.verdictFor(11.2).kind).toBe('unsafe');
    const wide = new VerdictTimeline();
    const unsafe = entry(10, true);
    wide.add(unsafe);
    wide.add(entry(10 + BRIDGE_HORIZON_SEC + 2, false));
    expect(wide.verdictFor(10 + BRIDGE_HORIZON_SEC + 1)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('never masks before the first verdict (no pre-roll)', () => {
    const track = new VerdictTimeline();
    track.add(entry(BRIDGE_HORIZON_SEC + 2, true));

    // A frame before an upcoming unsafe sample has no verdict: fail closed
    // with the whole-blur, never a pre-rolled mask.
    expect(track.verdictFor(1).kind).toBe('none');
    expect(track.verdictFor(1, BRIDGE_HORIZON_SEC + 2).kind).toBe('none');
    expect(track.verdictFor(BRIDGE_HORIZON_SEC + 1.9).kind).toBe('none');
  });

  it('merges the unsafe verdicts bounding a frame (inertia)', () => {
    const track = new VerdictTimeline();
    const a = entry(1, true);
    const b = entry(1.4, true);
    track.add(a);
    track.add(b);
    track.add(entry(1.2, false));

    const verdict = track.verdictFor(1.2);
    expect(verdict).toEqual({ kind: 'unsafe', entries: [a, b] });
  });

  it('clears immediately once only clean verdicts sit behind (no trailing hold)', () => {
    const track = new VerdictTimeline();
    track.add(entry(1, true));
    track.add(entry(1.25, false));
    track.add(entry(1.5, false));

    expect(track.verdictFor(1.75)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(2.1)).toEqual({ kind: 'clean' });
  });

  it('presents clean across a clean↔clean hole at any distance (closest verdict wins)', () => {
    const track = new VerdictTimeline();
    track.add(entry(10, false));
    track.add(entry(500, false));

    expect(track.verdictFor(10.4)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(250)).toEqual({ kind: 'clean' });
  });

  it('does not composite mask geometry from an upcoming verdict beyond the bridge horizon', () => {
    const track = new VerdictTimeline();
    const near = entry(10, true);
    track.add(near);
    track.add(entry(600, true));

    expect(track.verdictFor(10.4)).toEqual({ kind: 'unsafe', entries: [near] });
  });

  it('keeps entries ordered even when an older verdict arrives late', () => {
    const track = new VerdictTimeline();
    track.add(entry(2, false));
    track.add(entry(1, true)); // late redelivery of an older sample

    expect(track.verdictFor(1.05).kind).toBe('unsafe');
    // The clean verdict at 2 is not yet confirmed by a following clean one,
    // so the earlier unsafe mask still holds past it.
    expect(track.verdictFor(2.05).kind).toBe('unsafe');
  });

  it('bounds session-lifetime growth by dropping the oldest entries', () => {
    const timeline = new VerdictTimeline();
    for (let i = 0; i < MAX_TIMELINE_ENTRIES + 10; i++) timeline.add(entry(i * 0.25, false));

    expect(timeline.size()).toBe(MAX_TIMELINE_ENTRIES);
    expect(timeline.verdictFor(0)).toEqual({ kind: 'clean' });
    expect(timeline.verdictFor((MAX_TIMELINE_ENTRIES + 9) * 0.25).kind).toBe('clean');
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
