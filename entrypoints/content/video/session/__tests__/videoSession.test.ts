import { describe, expect, it } from 'vitest';

import {
  createVideoSession,
  reduce,
  type SessionEffect,
  type SessionEvent,
  type VideoSessionState,
  verdictOptionsOf,
} from '@/entrypoints/content/video/session/videoSession';
import { VerdictInterpreter } from '@/entrypoints/content/video/timeline/verdictInterpreter';

import type { VerdictEntry } from '@/entrypoints/content/video/timeline/verdictTimeline';

function run(events: SessionEvent[], start: VideoSessionState = createVideoSession().state) {
  let state = start;
  const effects: SessionEffect[][] = [];
  for (const event of events) {
    const result = reduce(state, event);
    ({ state } = result);
    effects.push(result.effects);
  }
  return { state, effects, last: effects.at(-1) ?? [], all: effects.flat() };
}

const kinds = (effects: SessionEffect[]) => effects.map(effect => effect.kind);

const verdictAt = (timestampSec: number, unsafe: boolean): VerdictEntry => ({
  timestampSec,
  unsafe,
  predictions: unsafe
    ? [
        {
          classId: 0,
          className: 'unsafe',
          probability: 0.55,
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
          masks: { width: 0, height: 0, startValue: 0, runs: [] },
        },
      ]
    : [],
  maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  width: 640,
  height: 360,
});

describe('Video Session: Live Masking hand-off', () => {
  it('starts Live Masking while coverage ahead is under 1.5 s and stops it only at 5 s', () => {
    const { effects } = run([
      { type: 'tapReachable' },
      { type: 'play' },
      { type: 'progress', coverageAheadSec: 1.2 },
      { type: 'progress', coverageAheadSec: 3 },
      { type: 'progress', coverageAheadSec: 5 },
      { type: 'progress', coverageAheadSec: 3 },
      { type: 'progress', coverageAheadSec: 1.4 },
    ]);

    expect(effects.map(kinds)).toEqual([[], [], [], [], ['stopLiveMasking'], [], ['startLiveMasking']]);
  });

  it('runs Live Masking from attachment, before the tap is known', () => {
    expect(kinds(createVideoSession().effects)).toEqual(['applyBlur', 'startLiveMasking']);
  });
});

describe('Video Session: unreachable bitstream', () => {
  it('keeps Live Masking for the whole session however much coverage exists', () => {
    const { state, all } = run([
      { type: 'tapUnreachable' },
      { type: 'play' },
      { type: 'progress', coverageAheadSec: 30 },
    ]);

    expect(state.liveMasking).toBe(true);
    expect(kinds(all)).not.toContain('stopLiveMasking');
  });
});

describe('Video Session: live samples', () => {
  it('commits a low-confidence unsafe live sample at once, with no re-sample', () => {
    const { last } = run([{ type: 'play' }, { type: 'liveSample', sampleId: 'a' }]);

    expect(last).toContainEqual({ kind: 'commitSample', sampleId: 'a' });
    expect(kinds(last)).not.toContain('requestLiveSample');
  });
});

describe('Video Session: masking rule per mode', () => {
  const unsafeThenUnconfirmedClean = () => {
    const interpreter = new VerdictInterpreter();
    interpreter.record(verdictAt(10, true));
    interpreter.record(verdictAt(10.5, false));
    return interpreter;
  };

  it('holds a mask until a confirmed clean verdict under Live Masking, even when live samples stall', () => {
    const { state } = run([{ type: 'tapUnreachable' }, { type: 'play' }]);

    expect(state.liveMasking).toBe(true);
    expect(unsafeThenUnconfirmedClean().verdictFor(10.5 + 10, verdictOptionsOf(state)).kind).toBe('unsafe');
  });

  it('cuts the mask at the span end under lookahead', () => {
    const { state } = run([{ type: 'tapReachable' }, { type: 'play' }, { type: 'progress', coverageAheadSec: 8 }]);

    expect(state.liveMasking).toBe(false);
    expect(unsafeThenUnconfirmedClean().verdictFor(10.6, verdictOptionsOf(state))).toEqual({ kind: 'clean' });
  });
});

describe('Video Session: status', () => {
  const statusEffects = (effects: SessionEffect[][]) =>
    effects.map(step => step.filter(effect => effect.kind === 'setStatus'));

  it('stays safe while an unsafe lookahead verdict waits ahead, and flips when its span is presented', () => {
    const { effects } = run([
      { type: 'tapReachable' },
      { type: 'verdict', sampleId: 'clean-0' },
      { type: 'verdict', sampleId: 'unsafe-ahead' },
      { type: 'presented', unsafe: true },
    ]);

    expect(statusEffects(effects)).toEqual([
      [],
      [{ kind: 'setStatus', status: 'safe' }],
      [],
      [{ kind: 'setStatus', status: 'unsafe' }],
    ]);
  });

  it('stays unsafe after the unsafe span ends', () => {
    const { state, last } = run([
      { type: 'tapReachable' },
      { type: 'verdict', sampleId: 'a' },
      { type: 'presented', unsafe: true },
      { type: 'presented', unsafe: false },
    ]);

    expect(last).toEqual([]);
    expect(state.status).toBe('unsafe');
  });

  it('keeps unsafe over a later skip', () => {
    const { state, last } = run([
      { type: 'verdict', sampleId: 'a' },
      { type: 'presented', unsafe: true },
      { type: 'liveCaptureFailed', permanent: true },
      { type: 'tapUnreachable' },
    ]);

    expect(state.phase).toBe('skipped');
    expect(state.status).toBe('unsafe');
    expect(last).not.toContainEqual({ kind: 'setStatus', status: 'skipped' });
  });

  it('starts unsafe when the source was already seen unsafe', () => {
    const born = createVideoSession({ unsafeSeen: true });
    const { last } = run([{ type: 'verdict', sampleId: 'a' }], born.state);

    expect(last).toContainEqual({ kind: 'setStatus', status: 'unsafe' });
  });

  it('reports unsafe rather than skipped when a source already seen unsafe is skipped', () => {
    const born = createVideoSession({ unsafeSeen: true });
    const { state, last } = run(
      [{ type: 'liveCaptureFailed', permanent: true }, { type: 'tapUnreachable' }],
      born.state,
    );

    expect(state.status).toBe('unsafe');
    expect(last).toContainEqual({ kind: 'setStatus', status: 'unsafe' });
  });

  it('turns unsafe when its identity resolves to media already seen unsafe', () => {
    const { state, last } = run([{ type: 'verdict', sampleId: 'a' }, { type: 'unsafeRemembered' }]);

    expect(state.status).toBe('unsafe');
    expect(last).toEqual([{ kind: 'setStatus', status: 'unsafe' }]);
  });

  it('starts unsafe when it learns the media was seen unsafe before its first verdict', () => {
    const { last } = run([{ type: 'unsafeRemembered' }, { type: 'verdict', sampleId: 'a' }]);

    expect(last).toContainEqual({ kind: 'setStatus', status: 'unsafe' });
  });

  it('reports a skipped session unsafe once it learns the media was seen unsafe', () => {
    const { state, last } = run([
      { type: 'liveCaptureFailed', permanent: true },
      { type: 'tapUnreachable' },
      { type: 'unsafeRemembered' },
    ]);

    expect(state.phase).toBe('skipped');
    expect(state.status).toBe('unsafe');
    expect(last).toEqual([{ kind: 'setStatus', status: 'unsafe' }]);
  });
});

describe('Video Session: paused frames', () => {
  it('samples an uncovered paused frame once', () => {
    const { effects } = run([
      { type: 'pause', covered: false },
      { type: 'pause', covered: false },
      { type: 'seeked', paused: true, covered: true, coverageAheadSec: 3 },
      { type: 'seeked', paused: true, covered: false, coverageAheadSec: 0 },
    ]);

    expect(effects.map(kinds)).toEqual([['requestLiveSample'], [], [], ['requestLiveSample']]);
  });
});

describe('Video Session: loops and seeks', () => {
  const covered = [{ type: 'tapReachable' }, { type: 'play' }, { type: 'progress', coverageAheadSec: 8 }] as const;

  it('does not reset coverage on a Loop Restart', () => {
    const { last, state } = run([...covered, { type: 'loopRestarted' }]);

    expect(last).toEqual([]);
    expect(state.liveMasking).toBe(false);
  });

  it('starts Live Masking on a seek into uncovered media', () => {
    const { last } = run([...covered, { type: 'seeked', paused: false, covered: false, coverageAheadSec: 0 }]);

    expect(last).toEqual([{ kind: 'startLiveMasking' }]);
  });

  it('keeps Live Masking off on a backward seek into covered media', () => {
    const { last, state } = run([...covered, { type: 'seeked', paused: false, covered: true, coverageAheadSec: 2 }]);

    expect(last).toEqual([]);
    expect(state.liveMasking).toBe(false);
  });
});

describe('Video Session: coverage to the media end', () => {
  it('stops Live Masking on a fully analysed clip shorter than 5 s', () => {
    const { state, last } = run([
      { type: 'tapReachable' },
      { type: 'play' },
      { type: 'progress', coverageAheadSec: Number.POSITIVE_INFINITY },
    ]);

    expect(last).toEqual([{ kind: 'stopLiveMasking' }]);
    expect(state.liveMasking).toBe(false);
  });

  it('does not restart Live Masking in the covered tail of a video or loop', () => {
    const { all } = run([
      { type: 'tapReachable' },
      { type: 'play' },
      { type: 'progress', coverageAheadSec: 8 },
      { type: 'progress', coverageAheadSec: Number.POSITIVE_INFINITY },
      { type: 'loopRestarted' },
      { type: 'progress', coverageAheadSec: Number.POSITIVE_INFINITY },
    ]);

    expect(kinds(all)).toEqual(['stopLiveMasking']);
  });
});

describe('Video Session: initial blur', () => {
  it('releases the blur on the first verdict of any kind', () => {
    expect(kinds(run([{ type: 'verdict', sampleId: 'a' }]).last)).toContain('clearBlur');
    expect(kinds(run([{ type: 'thumbnailVerdict', unsafe: false }]).last)).toContain('clearBlur');
    expect(kinds(run([{ type: 'liveSample', sampleId: 'a' }]).last)).toContain('clearBlur');
  });

  it('releases it only once', () => {
    const { last } = run([
      { type: 'verdict', sampleId: 'a' },
      { type: 'verdict', sampleId: 'b' },
    ]);

    expect(kinds(last)).not.toContain('clearBlur');
  });
});

describe('Video Session: unreadable page pixels', () => {
  const permanentCaptureFailure = { type: 'liveCaptureFailed', permanent: true } as const;

  it('finalizes as skipped and un-blurred when no Bitstream Tap is reachable', () => {
    const { state, all } = run([permanentCaptureFailure, { type: 'tapUnreachable' }]);

    expect(state.phase).toBe('skipped');
    expect(all).toEqual(
      expect.arrayContaining([
        { kind: 'stopLiveMasking' },
        { kind: 'clearBlur' },
        { kind: 'setStatus', status: 'skipped' },
      ]),
    );
  });

  it('plays uncovered spans un-blurred when a tap is reachable, with status following presented spans', () => {
    const { state, all } = run([
      { type: 'tapReachable' },
      permanentCaptureFailure,
      { type: 'verdict', sampleId: 'a' },
      { type: 'presented', unsafe: true },
    ]);

    expect(state.phase).toBe('active');
    expect(state.liveMasking).toBe(false);
    expect(kinds(all)).toContain('clearBlur');
    expect(all).not.toContainEqual({ kind: 'setStatus', status: 'skipped' });
    expect(state.status).toBe('unsafe');
  });

  it('ignores transient capture failures', () => {
    expect(run([{ type: 'liveCaptureFailed', permanent: false }]).last).toEqual([]);
  });
});

describe('Video Session: viewport', () => {
  it('stops Live Masking offscreen and resumes it on return', () => {
    const { effects } = run([
      { type: 'visibility', visible: false },
      { type: 'visibility', visible: true },
    ]);

    expect(effects.map(kinds)).toEqual([['stopLiveMasking'], ['startLiveMasking']]);
  });
});

describe('Video Session: source change on the same media', () => {
  const watched = [
    { type: 'tapReachable' },
    { type: 'play' },
    { type: 'verdict', sampleId: 'a' },
    { type: 'presented', unsafe: true },
    { type: 'progress', coverageAheadSec: 8 },
  ] as const;

  it('re-opens the tap on a quality switch, keeping status and blur and without restarting Live Masking', () => {
    const { last, state } = run([...watched, { type: 'sourceChanged', coverageAheadSec: 8 }]);

    expect(last).toEqual([{ kind: 'reopenTap' }]);
    expect(state).toMatchObject({ status: 'unsafe', blurred: false, liveMasking: false, verdictSeen: true });
  });

  it('keeps coverage while the new source resolves its tap', () => {
    const { effects } = run([
      ...watched,
      { type: 'sourceChanged', coverageAheadSec: 8 },
      { type: 'tapReachable' },
      { type: 'progress', coverageAheadSec: 6 },
    ]);

    expect(effects.slice(-2).map(kinds)).toEqual([[], []]);
  });

  it('starts Live Masking when the new source lands where coverage is short', () => {
    const { last } = run([...watched, { type: 'sourceChanged', coverageAheadSec: 0.5 }]);

    expect(last).toEqual([{ kind: 'reopenTap' }, { kind: 'startLiveMasking' }]);
  });

  it('falls back to Live Masking when the new source has no reachable tap', () => {
    const { last, state } = run([
      ...watched,
      { type: 'sourceChanged', coverageAheadSec: 8 },
      { type: 'tapUnreachable' },
    ]);

    expect(last).toEqual([{ kind: 'startLiveMasking' }]);
    expect(state.status).toBe('unsafe');
  });
});

describe('lookahead-only session (page pixels unreadable)', () => {
  const born = () => createVideoSession({ pagePixelsReadable: false });

  it('is born unblurred and without Live Masking', () => {
    const { state, effects } = born();
    expect(kinds(effects)).toEqual([]);
    expect(state.blurred).toBe(false);
    expect(state.liveMasking).toBe(false);
  });

  it('never starts Live Masking, whatever the coverage', () => {
    const { all } = run(
      [
        { type: 'tapReachable' },
        { type: 'play' },
        { type: 'progress', coverageAheadSec: 0 },
        { type: 'seeked', paused: false, covered: false, coverageAheadSec: 0 },
        { type: 'pause', covered: false },
      ],
      born().state,
    );
    expect(kinds(all)).not.toContain('startLiveMasking');
    expect(kinds(all)).not.toContain('requestLiveSample');
    expect(kinds(all)).not.toContain('applyBlur');
  });

  it('reports a status from lookahead verdicts once the tap is reachable', () => {
    const { state, last } = run([{ type: 'tapReachable' }, { type: 'verdict', sampleId: 's1' }], born().state);
    expect(state.status).toBe('safe');
    expect(kinds(last)).toEqual(['commitSample', 'setStatus']);
  });

  it('is skipped, never blurred, when no tap is reachable', () => {
    const { state, all } = run([{ type: 'tapUnreachable' }], born().state);
    expect(state.phase).toBe('skipped');
    expect(state.status).toBe('skipped');
    expect(kinds(all)).toEqual(['setStatus']);
  });
});
