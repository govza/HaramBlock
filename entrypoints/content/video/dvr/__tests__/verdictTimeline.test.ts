import { describe, expect, it } from 'vitest';

import {
  BRIDGE_HORIZON_SEC,
  INERTIA_JITTER_MARGIN_SEC,
  MAX_INERTIA_WINDOW_SEC,
  MIN_INERTIA_WINDOW_SEC,
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
  it('answers unsafe/clean/none by window lookup, fail-closed when no verdict is near', () => {
    const track = new VerdictTimeline();
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
    const track = new VerdictTimeline();
    track.add(entry(1, true));
    track.add(entry(3.5, true)); // 2.5s hole: an inference-latency spike

    // Inside the hole, beyond both windows: the unsafe neighbors keep masking.
    const bridged = track.verdictFor(2.2, 0.5);
    expect(bridged.kind).toBe('unsafe');

    // A past unsafe verdict covers only a short forward overshoot; further out
    // it may no longer describe the scene, so it fails closed instead of
    // smearing a stale mask forward.
    expect(track.verdictFor(3.5 + 0.9, 0.5).kind).toBe('unsafe');
    expect(track.verdictFor(3.5 + 1.5, 0.5).kind).toBe('none');

    // A hole between two clean verdicts presents clean.
    const cleanTrack = new VerdictTimeline();
    cleanTrack.add(entry(1, false));
    cleanTrack.add(entry(3.5, false));
    expect(cleanTrack.verdictFor(2.2, 0.5)).toEqual({ kind: 'clean' });

    // A lone clean verdict covers only a short overshoot, then fails closed.
    expect(cleanTrack.verdictFor(3.5 + 0.9, 0.5)).toEqual({ kind: 'clean' });
    expect(cleanTrack.verdictFor(3.5 + 1.2, 0.5)).toEqual({ kind: 'none' });
  });

  it('fails closed in the hole trailing an unsafe verdict instead of bridging to clean', () => {
    const track = new VerdictTimeline();
    track.add(entry(10, true));
    track.add(entry(12, false)); // inference stalled, then came back clean

    // Inside the overshoot the stale mask still covers.
    expect(track.verdictFor(10.5, 0.35).kind).toBe('unsafe');
    // Past it the mask must not smear — but a clean verdict two seconds later
    // says nothing about this frame either: whole-blur, never clean.
    expect(track.verdictFor(11.2, 0.35)).toEqual({ kind: 'none' });
  });

  it('stretches the backward unsafe bridge further when given a wider horizon (slow inference)', () => {
    const track = new VerdictTimeline();
    track.add(entry(BRIDGE_HORIZON_SEC + 2, true));

    // Beyond the default horizon…
    expect(track.verdictFor(1, 0.5).kind).toBe('none');
    // …but a session whose round-trip demands it pre-rolls the mask instead.
    expect(track.verdictFor(1, 0.5, BRIDGE_HORIZON_SEC + 2).kind).toBe('unsafe');
  });

  it('merges all unsafe verdicts inside the window (inertia)', () => {
    const track = new VerdictTimeline();
    const a = entry(1, true);
    const b = entry(1.4, true);
    track.add(a);
    track.add(b);
    track.add(entry(1.2, false));

    const verdict = track.verdictFor(1.2, 0.5);
    expect(verdict).toEqual({ kind: 'unsafe', entries: [a, b] });
  });

  it('clears immediately once only clean verdicts sit in the window (no trailing hold)', () => {
    const track = new VerdictTimeline();
    track.add(entry(1, true));
    track.add(entry(1.25, false));
    track.add(entry(1.5, false));

    expect(track.verdictFor(1.75, 0.5)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(2.1, 0.5)).toEqual({ kind: 'clean' });
  });

  it('keeps entries ordered even when an older verdict arrives late', () => {
    const track = new VerdictTimeline();
    track.add(entry(2, false));
    track.add(entry(1, true)); // late redelivery of an older sample

    expect(track.verdictFor(1.05, 0.2).kind).toBe('unsafe');
    expect(track.verdictFor(2.05, 0.2).kind).toBe('clean');
  });

  it('bounds session-lifetime growth by dropping the oldest entries', () => {
    const timeline = new VerdictTimeline();
    for (let i = 0; i < MAX_TIMELINE_ENTRIES + 10; i++) timeline.add(entry(i * 0.25, false));

    expect(timeline.size()).toBe(MAX_TIMELINE_ENTRIES);
    // The oldest entries fell off; the newest still answer.
    expect(timeline.verdictFor(0, 0.1)).toEqual({ kind: 'none' });
    expect(timeline.verdictFor((MAX_TIMELINE_ENTRIES + 9) * 0.25, 0.1).kind).toBe('clean');
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

  it('derives the inertia window from the observed cadence, clamped and padded', () => {
    const track = new VerdictTimeline();
    // No cadence yet: floor + margin.
    expect(track.inertiaWindowSec()).toBeCloseTo(MIN_INERTIA_WINDOW_SEC + INERTIA_JITTER_MARGIN_SEC);

    // ~0.5 s cadence: window follows the median gap.
    for (let i = 0; i < 6; i++) track.add(entry(i * 0.5, false));
    expect(track.inertiaWindowSec()).toBeCloseTo(0.5 + INERTIA_JITTER_MARGIN_SEC);

    // Sparse verdicts (throttled tab): capped so one verdict cannot cover seconds.
    const sparse = new VerdictTimeline();
    for (let i = 0; i < 6; i++) sparse.add(entry(i * 10, false));
    expect(sparse.inertiaWindowSec()).toBeCloseTo(MAX_INERTIA_WINDOW_SEC + INERTIA_JITTER_MARGIN_SEC);

    // Dense verdicts: floored to the detection-jitter guard.
    const dense = new VerdictTimeline();
    for (let i = 0; i < 6; i++) dense.add(entry(i * 0.05, false));
    expect(dense.inertiaWindowSec()).toBeCloseTo(MIN_INERTIA_WINDOW_SEC + INERTIA_JITTER_MARGIN_SEC);
  });
});
