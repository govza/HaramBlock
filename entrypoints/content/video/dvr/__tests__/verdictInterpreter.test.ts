import { describe, expect, it } from 'vitest';

import { VerdictInterpreter, type ResolvedRun } from '@/entrypoints/content/video/dvr/verdictInterpreter';
import { BRIDGE_HORIZON_SEC, PRE_MASK_LEAD_SEC } from '@/entrypoints/content/video/maskTiming';

import type { VerdictEntry } from '@/entrypoints/content/video/dvr/verdictTimeline';

const SCORE_THRESHOLD = 0.5;
const CONFIDENT_PROBABILITY = 0.9;

function entry(timestampSec: number, unsafe: boolean, probability = CONFIDENT_PROBABILITY): VerdictEntry {
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
  return interpreter.record(verdict, SCORE_THRESHOLD);
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
    expect(track.verdictFor(2 + BRIDGE_HORIZON_SEC + 0.1)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('does not pre-mask across a coverage gap', () => {
    const track = new VerdictInterpreter();
    add(track, entry(1, false));
    add(track, entry(10, true));

    expect(track.verdictFor(10 - PRE_MASK_LEAD_SEC / 2)).toEqual({ kind: 'clean' });
  });

  it('does not pre-mask before a suppressed Transient Hit', () => {
    const track = new VerdictInterpreter();
    add(track, entry(10, false));
    add(track, entry(10.5, true, 0.6));
    add(track, entry(11, false));

    expect(track.verdictFor(10.5 - PRE_MASK_LEAD_SEC / 2)).toEqual({ kind: 'clean' });
  });

  it('cuts the mask at a clean verdict confirmed by a following clean verdict', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(track, unsafe);
    add(track, entry(10.5, false));
    add(track, entry(11, false));

    expect(track.verdictFor(10.4)).toEqual({ kind: 'unsafe', entries: [unsafe] });
    expect(track.verdictFor(10.6)).toEqual({ kind: 'clean' });
  });

  it('holds the mask over an unconfirmed clean verdict (no following verdict yet)', () => {
    const track = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(track, unsafe);
    add(track, entry(10.5, false));

    expect(track.verdictFor(10.6)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('does not trust a lone clean verdict between two unsafe ones', () => {
    const track = new VerdictInterpreter();
    const a = entry(10, true);
    const b = entry(11, true);
    add(track, a);
    add(track, entry(10.5, false));
    add(track, b);

    expect(track.verdictFor(10.6)).toEqual({ kind: 'unsafe', entries: [a, b] });
  });

  it('bridges coverage holes instead of blurring between masked stretches', () => {
    const track = new VerdictInterpreter();
    add(track, entry(1, true));
    const last = entry(3.5, true);
    add(track, last);

    const bridged = track.verdictFor(2.2);
    expect(bridged.kind).toBe('unsafe');

    expect(track.verdictFor(3.5 + 0.9).kind).toBe('unsafe');
    expect(track.verdictFor(3.5 + 10)).toEqual({ kind: 'unsafe', entries: [last] });

    const cleanTrack = new VerdictInterpreter();
    add(cleanTrack, entry(1, false));
    add(cleanTrack, entry(3.5, false));
    expect(cleanTrack.verdictFor(2.2)).toEqual({ kind: 'clean' });

    expect(cleanTrack.verdictFor(3.5 + 0.9)).toEqual({ kind: 'clean' });
    expect(cleanTrack.verdictFor(3.5 + 10)).toEqual({ kind: 'clean' });
  });

  it('masks the whole span from an unsafe sample to the next clean verdict', () => {
    const track = new VerdictInterpreter();
    add(track, entry(10, true));
    add(track, entry(12, false));

    expect(track.verdictFor(10.5).kind).toBe('unsafe');
    expect(track.verdictFor(11.2).kind).toBe('unsafe');
    const wide = new VerdictInterpreter();
    const unsafe = entry(10, true);
    add(wide, unsafe);
    add(wide, entry(10 + BRIDGE_HORIZON_SEC + 2, false));
    expect(wide.verdictFor(10 + BRIDGE_HORIZON_SEC + 1)).toEqual({ kind: 'unsafe', entries: [unsafe] });
  });

  it('never masks before the first verdict (no pre-roll)', () => {
    const track = new VerdictInterpreter();
    add(track, entry(BRIDGE_HORIZON_SEC + 2, true));

    expect(track.verdictFor(1).kind).toBe('none');
    expect(track.verdictFor(1, BRIDGE_HORIZON_SEC + 2).kind).toBe('none');
    expect(track.verdictFor(BRIDGE_HORIZON_SEC + 1.9).kind).toBe('none');
  });

  it('merges the unsafe verdicts bounding a frame (inertia)', () => {
    const track = new VerdictInterpreter();
    const a = entry(1, true);
    const b = entry(1.4, true);
    add(track, a);
    add(track, b);
    add(track, entry(1.2, false));

    const verdict = track.verdictFor(1.2);
    expect(verdict).toEqual({ kind: 'unsafe', entries: [a, b] });
  });

  it('clears immediately once only clean verdicts sit behind (no trailing hold)', () => {
    const track = new VerdictInterpreter();
    add(track, entry(1, true));
    add(track, entry(1.25, false));
    add(track, entry(1.5, false));

    expect(track.verdictFor(1.75)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(2.1)).toEqual({ kind: 'clean' });
  });

  it('presents clean across a clean↔clean hole at any distance (closest verdict wins)', () => {
    const track = new VerdictInterpreter();
    add(track, entry(10, false));
    add(track, entry(500, false));

    expect(track.verdictFor(10.4)).toEqual({ kind: 'clean' });
    expect(track.verdictFor(250)).toEqual({ kind: 'clean' });
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
    expect(track.verdictFor(2.05).kind).toBe('unsafe');
  });
});

const LOW_PROBABILITY = 0.6;

describe('VerdictInterpreter Transient Hits', () => {
  it('presents an isolated low-confidence hit between clean samples as clean', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(10, false));
    add(interpreter, entry(10.25, true, LOW_PROBABILITY));
    add(interpreter, entry(10.5, false));
    add(interpreter, entry(10.75, false));

    expect(interpreter.verdictFor(10.3)).toEqual({ kind: 'clean' });
    expect(interpreter.verdictFor(10.6)).toEqual({ kind: 'clean' });
  });

  it('suppresses a low-confidence run up to the configured length and masks a longer one', () => {
    const suppressed = new VerdictInterpreter();
    add(suppressed, entry(10, false));
    for (const t of [10.25, 10.5, 10.75]) add(suppressed, entry(t, true, LOW_PROBABILITY));
    add(suppressed, entry(11, false));
    add(suppressed, entry(11.25, false));

    const masked = new VerdictInterpreter();
    add(masked, entry(10, false));
    for (const t of [10.25, 10.5, 10.75, 11]) add(masked, entry(t, true, LOW_PROBABILITY));
    add(masked, entry(11.25, false));
    add(masked, entry(11.5, false));

    expect(suppressed.verdictFor(10.6)).toEqual({ kind: 'clean' });
    expect(masked.verdictFor(10.6).kind).toBe('unsafe');
  });

  it('masks a short run once one of its samples is a Confident Hit', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(10, false));
    add(interpreter, entry(10.25, true, LOW_PROBABILITY));
    add(interpreter, entry(10.5, true, 0.75));
    add(interpreter, entry(10.75, false));
    add(interpreter, entry(11, false));

    expect(interpreter.verdictFor(10.3).kind).toBe('unsafe');
  });

  it('caps the Confident Hit bar for lenient thresholds', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(10, false));
    interpreter.record(entry(10.25, true, 0.95), 0.9);
    add(interpreter, entry(10.5, false));
    add(interpreter, entry(10.75, false));

    expect(interpreter.verdictFor(10.3).kind).toBe('unsafe');
  });

  it('fails closed while the clean sample closing a run has not arrived', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(10, false));
    add(interpreter, entry(10.25, true, LOW_PROBABILITY));

    expect(interpreter.verdictFor(10.3).kind).toBe('unsafe');
  });

  it('does not suppress a run whose closing clean sample lies beyond a coverage gap', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(10, false));
    add(interpreter, entry(10.25, true, LOW_PROBABILITY));
    add(interpreter, entry(13, false));
    add(interpreter, entry(13.25, false));

    expect(interpreter.verdictFor(10.3).kind).toBe('unsafe');
  });

  it('treats a coverage gap before a run as a clean start', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(5, true));
    add(interpreter, entry(30, true, LOW_PROBABILITY));
    add(interpreter, entry(30.25, false));
    add(interpreter, entry(30.5, false));

    expect(interpreter.verdictFor(30.1)).toEqual({ kind: 'clean' });
  });

  it('never holds or bridges a mask from a suppressed run', () => {
    const interpreter = new VerdictInterpreter();
    const real = entry(10, true);
    add(interpreter, real);
    add(interpreter, entry(10.25, false));
    add(interpreter, entry(10.5, true, LOW_PROBABILITY));
    add(interpreter, entry(10.75, false));
    add(interpreter, entry(11, false));

    expect(interpreter.verdictFor(10.1)).toEqual({ kind: 'unsafe', entries: [real] });
    expect(interpreter.verdictFor(10.8)).toEqual({ kind: 'clean' });
  });

  it('keeps masking a whole run first presented before its closing clean sample arrived', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(10, false));
    add(interpreter, entry(10.25, true, LOW_PROBABILITY));
    expect(interpreter.verdictFor(10.3).kind).toBe('unsafe');

    add(interpreter, entry(10.5, true, LOW_PROBABILITY));
    add(interpreter, entry(10.75, false));
    add(interpreter, entry(11, false));

    expect(interpreter.verdictFor(10.4).kind).toBe('unsafe');
    expect(interpreter.verdictFor(10.6).kind).toBe('unsafe');
    expect(interpreter.verdictFor(10.8)).toEqual({ kind: 'clean' });
  });
});

describe('VerdictInterpreter latched suppression', () => {
  function suppressedAt10() {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(9.75, false));
    add(interpreter, entry(10, true, LOW_PROBABILITY));
    add(interpreter, entry(10.25, false));
    add(interpreter, entry(10.5, false));
    interpreter.verdictFor(10.1);
    return interpreter;
  }

  it('lets a Confident Hit re-sampled into a suppressed run overturn it', () => {
    const interpreter = suppressedAt10();

    expect(add(interpreter, entry(10.1, true))).toBe('unsafe');
    expect(interpreter.verdictFor(10.15).kind).toBe('unsafe');
  });

  it('lets re-sampled hits that outgrow the limit overturn a suppressed run', () => {
    const interpreter = suppressedAt10();
    for (const t of [9.8, 9.85, 9.9]) add(interpreter, entry(t, true, LOW_PROBABILITY));

    expect(interpreter.verdictFor(9.95).kind).toBe('unsafe');
  });
});

describe('VerdictInterpreter sample classification', () => {
  it('classifies a low-confidence hit as tentative until its run outgrows the limit', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(10, false));

    expect(add(interpreter, entry(10.25, true, LOW_PROBABILITY))).toBe('tentative');
    expect(add(interpreter, entry(10.5, true, LOW_PROBABILITY))).toBe('tentative');
    expect(add(interpreter, entry(10.75, true, LOW_PROBABILITY))).toBe('tentative');
    expect(add(interpreter, entry(11, true, LOW_PROBABILITY))).toBe('unsafe');
  });

  it('classifies a Confident Hit as unsafe immediately', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(10, false));

    expect(add(interpreter, entry(10.25, true))).toBe('unsafe');
  });

  it('confirms a clean sample only when the verdict before it, at any distance, is not a hit', () => {
    const interpreter = new VerdictInterpreter();

    expect(add(interpreter, entry(10, false))).toBe('clean');
    expect(add(interpreter, entry(10.25, false))).toBe('confirmedClean');
    add(interpreter, entry(10.5, true));
    expect(add(interpreter, entry(10.75, false))).toBe('clean');
    expect(add(interpreter, entry(11, false))).toBe('confirmedClean');
    add(interpreter, entry(15, true));
    expect(add(interpreter, entry(20, false))).toBe('clean');
    expect(add(interpreter, entry(40, false))).toBe('confirmedClean');
  });

  it('confirms the clean sample that closes a Transient Hit', () => {
    const interpreter = new VerdictInterpreter();
    add(interpreter, entry(10, false));
    add(interpreter, entry(10.25, true, LOW_PROBABILITY));

    expect(add(interpreter, entry(10.5, false))).toBe('confirmedClean');
  });
});

describe('VerdictInterpreter run resolutions', () => {
  function resolving() {
    const resolved: ResolvedRun[] = [];
    const interpreter = new VerdictInterpreter({ onRunResolved: run => resolved.push(run) });
    return { interpreter, resolved };
  }

  it('reports a suppressed run once, when it is first presented', () => {
    const { interpreter, resolved } = resolving();
    add(interpreter, entry(10, false));
    add(interpreter, entry(10.25, true, LOW_PROBABILITY));
    add(interpreter, entry(10.5, true, 0.55));
    add(interpreter, entry(10.75, false));
    add(interpreter, entry(11, false));
    expect(resolved).toEqual([]);

    interpreter.verdictFor(10.3);
    interpreter.verdictFor(10.6);

    expect(resolved).toEqual([
      { resolution: 'suppressed', runLength: 2, topProbability: LOW_PROBABILITY, onsetGapSec: 0.25 },
    ]);
  });

  it('reports why a short run was masked', () => {
    const confident = resolving();
    add(confident.interpreter, entry(10, false));
    add(confident.interpreter, entry(10.25, true));
    add(confident.interpreter, entry(10.5, false));
    confident.interpreter.verdictFor(10.3);

    const late = resolving();
    add(late.interpreter, entry(10, false));
    add(late.interpreter, entry(10.25, true, LOW_PROBABILITY));
    late.interpreter.verdictFor(10.3);

    expect(confident.resolved).toEqual([
      { resolution: 'confident', runLength: 1, topProbability: CONFIDENT_PROBABILITY, onsetGapSec: 0.25 },
    ]);
    expect(late.resolved).toEqual([
      { resolution: 'late', runLength: 1, topProbability: LOW_PROBABILITY, onsetGapSec: 0.25 },
    ]);
  });

  it('reports a run too long to suppress once, at its start', () => {
    const { interpreter, resolved } = resolving();
    add(interpreter, entry(10, false));
    for (const t of [10.25, 10.5, 10.75, 11, 11.25]) add(interpreter, entry(t, true, LOW_PROBABILITY));
    add(interpreter, entry(11.5, false));

    for (const t of [10.3, 10.6, 10.8, 11.1, 11.3]) interpreter.verdictFor(t);

    expect(resolved).toEqual([
      { resolution: 'long', runLength: 4, topProbability: LOW_PROBABILITY, onsetGapSec: 0.25 },
    ]);
  });

  it('reports no onset gap when no adjacent clean sample precedes the run', () => {
    const { interpreter, resolved } = resolving();
    add(interpreter, entry(1, false));
    add(interpreter, entry(10, true));
    interpreter.verdictFor(10.1);

    expect(resolved).toEqual([
      { resolution: 'confident', runLength: 1, topProbability: CONFIDENT_PROBABILITY, onsetGapSec: null },
    ]);
  });
});

function cached(timestampSec: number, unsafe: boolean, probability = CONFIDENT_PROBABILITY) {
  const { predictions, maskTransform, width, height } = entry(timestampSec, unsafe, probability);
  return { timestampSec, predictions, input: { width, height, maskTransform } };
}

describe('VerdictInterpreter cached verdicts', () => {
  it('judges a clean cached entry clean', () => {
    const track = new VerdictInterpreter();
    track.seed([cached(1, false)], SCORE_THRESHOLD);
    const hit = track.cachedVerdictAt(1);
    expect(hit && track.judgeCached(hit)).toBe('clean');
  });

  it('judges a confident cached hit unsafe', () => {
    const track = new VerdictInterpreter();
    track.seed([cached(1, false), cached(1.5, true), cached(2, false)], SCORE_THRESHOLD);
    const hit = track.cachedVerdictAt(1.5);
    expect(hit && track.judgeCached(hit)).toBe('unsafe');
  });

  it('applies the transient rule to a lone low-confidence cached hit', () => {
    const track = new VerdictInterpreter();
    track.seed([cached(1, false), cached(1.5, true, 0.6), cached(2, false)], SCORE_THRESHOLD);
    const hit = track.cachedVerdictAt(1.5);
    expect(hit && track.judgeCached(hit)).toBe('tentative');
  });

  it('forgets cached entries on dropCached', () => {
    const track = new VerdictInterpreter();
    track.seed([cached(1, true)], SCORE_THRESHOLD);
    track.dropCached();
    expect(track.cachedVerdictAt(1)).toBeNull();
    expect(track.coverageAheadOf(1)).toBe(0);
  });
});
