import { describe, expect, it } from 'vitest';

import {
  BRIDGE_HORIZON_SEC,
  INERTIA_JITTER_MARGIN_SEC,
  MAX_INERTIA_WINDOW_SEC,
  MIN_INERTIA_WINDOW_SEC,
  TRAILING_UNSAFE_INERTIA_MULTIPLIER,
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
    // Nothing anywhere near (beyond the bridge horizon too) — fail closed.
    expect(track.verdictFor(2 + BRIDGE_HORIZON_SEC + 0.1, 0.5)).toEqual({ kind: 'none' });
  });

  it('bridges coverage holes instead of blurring between masked stretches', () => {
    const track = new VerdictTrack();
    track.add(entry(1, true));
    track.add(entry(3.5, true)); // 2.5s hole: an inference-latency spike

    // Inside the hole, beyond both windows: the unsafe neighbors keep masking.
    const bridged = track.verdictFor(2.2, 0.5);
    expect(bridged.kind).toBe('unsafe');

    // An unsafe verdict also extends forward past its window while the next
    // verdict is still in flight (never blur away from a known-unsafe region).
    expect(track.verdictFor(3.5 + 1.5, 0.5).kind).toBe('unsafe');

    // A hole between two clean verdicts presents clean.
    const cleanTrack = new VerdictTrack();
    cleanTrack.add(entry(1, false));
    cleanTrack.add(entry(3.5, false));
    expect(cleanTrack.verdictFor(2.2, 0.5)).toEqual({ kind: 'clean' });

    // A lone clean verdict covers only a short overshoot, then fails closed.
    expect(cleanTrack.verdictFor(3.5 + 0.9, 0.5)).toEqual({ kind: 'clean' });
    expect(cleanTrack.verdictFor(3.5 + 1.2, 0.5)).toEqual({ kind: 'none' });
  });

  it('stretches the unsafe bridge further when given a wider horizon (slow inference)', () => {
    const track = new VerdictTrack();
    track.add(entry(1, true));

    // Beyond the default horizon…
    expect(track.verdictFor(1 + BRIDGE_HORIZON_SEC + 1, 0.5).kind).toBe('none');
    // …but a session whose round-trip demands it keeps masking instead.
    expect(track.verdictFor(1 + BRIDGE_HORIZON_SEC + 1, 0.5, BRIDGE_HORIZON_SEC + 2).kind).toBe('unsafe');
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

  it('holds the last unsafe mask through short runs of clean detector dropouts', () => {
    const track = new VerdictTrack();
    const unsafe = entry(1, true);
    track.add(unsafe);
    track.add(entry(1.25, false));
    track.add(entry(1.5, false));

    const windowSec = 0.5;
    expect(track.verdictFor(1.75, windowSec)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(1.75 - unsafe.timestampSec).toBeLessThanOrEqual(windowSec * TRAILING_UNSAFE_INERTIA_MULTIPLIER);

    // Sustained clean coverage beyond the trailing hold opens normally.
    expect(track.verdictFor(2.1, windowSec)).toEqual({ kind: 'clean' });
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
    // Pruned entries no longer answer — only the survivor does (via bridging
    // up to the horizon, so probe beyond it).
    expect(track.verdictFor(3 - BRIDGE_HORIZON_SEC - 0.5, 0.3)).toEqual({ kind: 'none' });
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
