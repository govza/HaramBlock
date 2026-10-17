import { describe, expect, it } from 'vitest';

import { BRIDGE_HORIZON_SEC, COVERAGE_MAX_GAP_SEC } from '@/entrypoints/content/video/maskTiming';
import { VerdictInterpreter } from '@/entrypoints/content/video/timeline/verdictInterpreter';
import { PRE_MASK_LEAD_SEC } from '@/utils/lookahead/lattice';

import type { VerdictEntry } from '@/entrypoints/content/video/timeline/verdictTimeline';

const LIVE = { holdUntilConfirmedClean: true } as const;
const LOW_PROBABILITY = 0.55;

function entry(timestampSec: number, unsafe: boolean, probability = 0.9): VerdictEntry {
  return {
    timestampSec,
    unsafe,
    predictions: unsafe
      ? [
          {
            classId: 0,
            className: 'unsafe',
            probability,
            boundingBox: { x: 0, y: 0, width: 1, height: 1 },
            masks: { width: 0, height: 0, startValue: 0, runs: [] },
          },
        ]
      : [],
    maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    width: 640,
    height: 360,
  };
}

function add(interpreter: VerdictInterpreter, verdict: VerdictEntry) {
  interpreter.record(verdict);
}

describe('VerdictInterpreter clean-cut rule', () => {
  it('pre-masks only the lead just before a hit', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(2, true);
    add(track, entry(1, false));
    add(track, unsafe);

    expect(track.verdictFor(1.1)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(2 - PRE_MASK_LEAD_SEC - 0.01)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(2 - PRE_MASK_LEAD_SEC + 0.01)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(2 + COVERAGE_MAX_GAP_SEC - 0.1)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('does not pre-mask across a coverage gap', () => {
    const track = new VerdictInterpreter();
    add(track, entry(1, false));
    add(track, entry(10, true));

    expect(track.verdictFor(10 - PRE_MASK_LEAD_SEC / 2).kind).not.toBe('unsafe');
  });

  it('cuts the mask at a clean verdict confirmed by a following clean verdict, in either mode', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(track, unsafe);
    add(track, entry(10.5, false));
    add(track, entry(11, false));

    expect(track.verdictFor(10.4)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(10.6)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(10.6, LIVE)).toEqual({ kind: 'clean' });
  });

  it('bridges coverage holes within the coverage gap between masked stretches', () => {
    const track = new VerdictInterpreter();
    add(track, entry(1, true));
    add(track, entry(3.5, true));

    expect(track.verdictFor(2.2).kind).toBe('unsafe');
    expect(track.verdictFor(3.5 + 0.9).kind).toBe('unsafe');

    const cleanTrack = new VerdictInterpreter();
    add(cleanTrack, entry(1, false));
    add(cleanTrack, entry(3.5, false));
    expect(cleanTrack.verdictFor(2.2)).toEqual({ kind: 'clean' });
    expect(cleanTrack.verdictFor(3.5 + 0.9)).toEqual({ kind: 'clean' });
    expect(cleanTrack.verdictFor(3.5 + 10)).toEqual({ kind: 'none' });
    expect(cleanTrack.verdictFor(3.5 + 10, LIVE)).toEqual({ kind: 'none' });
  });

  it('masks the whole span from an unsafe sample to the next clean verdict', () => {
    const track = new VerdictInterpreter();
    add(track, entry(10, true));
    add(track, entry(12, false));

    expect(track.verdictFor(10.5).kind).toBe('unsafe');
    expect(track.verdictFor(11.2).kind).toBe('unsafe');
  });

  it('never masks before the first verdict (no pre-roll)', () => {
    const track = new VerdictInterpreter();
    add(track, entry(BRIDGE_HORIZON_SEC + 2, true));

    expect(track.verdictFor(1).kind).toBe('none');
    expect(track.verdictFor(1, { bridgeHorizonSec: BRIDGE_HORIZON_SEC + 2 }).kind).toBe('none');
    expect(track.verdictFor(BRIDGE_HORIZON_SEC + 1.9).kind).toBe('none');
  });

  it('clears immediately once only clean verdicts sit behind (no trailing hold)', () => {
    const track = new VerdictInterpreter();
    add(track, entry(1, true));
    add(track, entry(1.25, false));
    add(track, entry(1.5, false));

    expect(track.verdictFor(1.75)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(2.1, LIVE)).toEqual({ kind: 'clean' });
  });

  it('carries a verdict behind the playhead forward only within the coverage gap under lookahead', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(track, unsafe);
    add(track, entry(500, false));

    expect(track.verdictFor(10 + COVERAGE_MAX_GAP_SEC - 0.1)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(10 + COVERAGE_MAX_GAP_SEC + 0.1)).toEqual({ kind: 'none' });
    expect(track.verdictFor(250)).toEqual({ kind: 'none' });
  });

  it('does not composite mask geometry from an upcoming verdict beyond the bridge horizon', () => {
    const track = new VerdictInterpreter();
    const near = entry(10, true);
    add(track, near);
    add(track, entry(600, true));

    expect(track.verdictFor(10.4)).toEqual({ kind: 'unsafe', entries: [near] });
  });

  it('keeps entries ordered even when an older verdict arrives late', () => {
    const track = new VerdictInterpreter();
    add(track, entry(2, false));
    add(track, entry(1, true));

    expect(track.verdictFor(1.05).kind).toBe('unsafe');
    expect(track.verdictFor(1.9).kind).toBe('unsafe');
  });
});

describe('VerdictInterpreter under lookahead', () => {
  it('ends the mask at the span end at the coverage frontier', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(track, entry(9.5, false));
    add(track, unsafe);

    expect(track.verdictFor(10 + COVERAGE_MAX_GAP_SEC - 0.1)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(10 + COVERAGE_MAX_GAP_SEC + 0.1)).toEqual({ kind: 'none' });
  });

  it('cuts at the first clean verdict even before a following one confirms it', () => {
    const track = new VerdictInterpreter();
    add(track, entry(10, true));
    add(track, entry(10.5, false));

    expect(track.verdictFor(10.6)).toEqual({ kind: 'clean' });
  });

  it('presents a refined clean stretch between two unsafe verdicts as clean, masking the gap before the next', () => {
    const track = new VerdictInterpreter();
    const nextUnsafe = entry(11, true);
    add(track, entry(10, true));
    add(track, entry(10.5, false));
    add(track, entry(10.75, false));
    add(track, nextUnsafe);

    expect(track.verdictFor(10.6)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(10.8)).toEqual({ kind: 'unsafe', entries: [nextUnsafe] });
  });
});

describe('VerdictInterpreter under Live Masking', () => {
  it('holds an unsafe verdict at the frontier past the coverage gap until a confirmed clean verdict', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(track, entry(9.5, false));
    add(track, unsafe);

    expect(track.verdictFor(10 + COVERAGE_MAX_GAP_SEC + 3, LIVE)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('keeps holding when the next known sample lies beyond a coverage hole', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(track, unsafe);
    add(track, entry(30, false));
    add(track, entry(30.5, false));

    expect(track.verdictFor(10 + COVERAGE_MAX_GAP_SEC + 3, LIVE)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(10 + COVERAGE_MAX_GAP_SEC + 3)).toEqual({ kind: 'none' });
  });

  it('does not take a clean sample beyond a coverage hole as confirmation', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(track, unsafe);
    add(track, entry(10.5, false));
    add(track, entry(30, false));

    expect(track.verdictFor(10.6, LIVE)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('holds the mask over an unconfirmed clean verdict (no following verdict yet)', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(track, unsafe);
    add(track, entry(10.5, false));

    expect(track.verdictFor(10.6, LIVE)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(10.5 + COVERAGE_MAX_GAP_SEC + 3, LIVE)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('does not trust a lone clean verdict between two unsafe ones', () => {
    const track = new VerdictInterpreter();
    const a = entry(10, true);
    const b = entry(11, true);
    add(track, a);
    add(track, entry(10.5, false));
    add(track, b);

    expect(track.verdictFor(10.6, LIVE)).toEqual({ kind: 'unsafe', entries: [a, b] });
  });
});

describe('VerdictInterpreter without post-inference suppression', () => {
  it('masks an isolated low-confidence unsafe sample between clean samples, in either mode', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10.25, true, LOW_PROBABILITY);
    add(track, entry(10, false));
    add(track, unsafe);
    add(track, entry(10.5, false));
    add(track, entry(10.75, false));

    expect(track.verdictFor(10.25 - PRE_MASK_LEAD_SEC / 2)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(10.3)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(10.3, LIVE)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(10.6)).toEqual({ kind: 'clean' });
  });

  it('masks a single low-confidence live sample at once', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true, LOW_PROBABILITY);
    add(track, unsafe);

    expect(track.verdictFor(10.1, LIVE)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });
});
