import { describe, expect, it } from 'vitest';

import {
  INERTIA_JITTER_MARGIN_SEC,
  MAX_INERTIA_WINDOW_SEC,
  MIN_INERTIA_WINDOW_SEC,
  VerdictTrack,
  type VerdictEntry,
} from '@/entrypoints/content/video/dvr/verdictTrack';

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

describe('VerdictTrack', () => {
  it('answers unsafe/clean/none by window lookup, fail-closed when no verdict is near', () => {
    const track = new VerdictTrack();
    track.add(entry(1, false));
    track.add(entry(2, true));

    // Near the clean verdict only.
    expect(track.verdictFor(1.1, 0.3)).toEqual({ kind: 'clean' });
    // Any unsafe verdict in the window wins over a clean one.
    expect(track.verdictFor(1.6, 0.5).kind).toBe('unsafe');
    // Nothing near: inference is running late — fail closed.
    expect(track.verdictFor(5, 0.5)).toEqual({ kind: 'none' });
    // Before the first verdict, same answer.
    expect(track.verdictFor(0.2, 0.5)).toEqual({ kind: 'none' });
  });

  it('merges all unsafe verdicts inside the window (inertia)', () => {
    const track = new VerdictTrack();
    const a = entry(1, true);
    const b = entry(1.4, true);
    track.add(a);
    track.add(b);
    track.add(entry(1.2, false));

    const verdict = track.verdictFor(1.2, 0.5);
    expect(verdict).toEqual({ kind: 'unsafe', entries: [a, b] });
  });

  it('keeps entries ordered even when an older verdict arrives late', () => {
    const track = new VerdictTrack();
    track.add(entry(2, false));
    track.add(entry(1, true)); // late redelivery of an older sample

    expect(track.verdictFor(1.05, 0.2).kind).toBe('unsafe');
    expect(track.verdictFor(2.05, 0.2).kind).toBe('clean');
  });

  it('prunes verdicts behind the buffer horizon', () => {
    const track = new VerdictTrack();
    track.add(entry(1, true));
    track.add(entry(2, true));
    track.add(entry(3, true));

    track.prune(2.5);
    expect(track.size()).toBe(1);
    expect(track.verdictFor(1, 0.3)).toEqual({ kind: 'none' });
    expect(track.verdictFor(3, 0.3).kind).toBe('unsafe');
  });

  it('derives the inertia window from the observed cadence, clamped and padded', () => {
    const track = new VerdictTrack();
    // No cadence yet: floor + margin.
    expect(track.inertiaWindowSec()).toBeCloseTo(MIN_INERTIA_WINDOW_SEC + INERTIA_JITTER_MARGIN_SEC);

    // ~0.5 s cadence: window follows the median gap.
    for (let i = 0; i < 6; i++) track.add(entry(i * 0.5, false));
    expect(track.inertiaWindowSec()).toBeCloseTo(0.5 + INERTIA_JITTER_MARGIN_SEC);

    // Sparse verdicts (throttled tab): capped so one verdict cannot cover seconds.
    const sparse = new VerdictTrack();
    for (let i = 0; i < 6; i++) sparse.add(entry(i * 10, false));
    expect(sparse.inertiaWindowSec()).toBeCloseTo(MAX_INERTIA_WINDOW_SEC + INERTIA_JITTER_MARGIN_SEC);

    // Dense verdicts: floored to the detection-jitter guard.
    const dense = new VerdictTrack();
    for (let i = 0; i < 6; i++) dense.add(entry(i * 0.05, false));
    expect(dense.inertiaWindowSec()).toBeCloseTo(MIN_INERTIA_WINDOW_SEC + INERTIA_JITTER_MARGIN_SEC);
  });
});
