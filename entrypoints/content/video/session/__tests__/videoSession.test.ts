import { describe, expect, it } from 'vitest';

import {
  createVideoSession,
  reduce,
  type SessionEffect,
  type SessionEvent,
  type VideoSessionState,
} from '@/entrypoints/content/video/session/videoSession';

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

describe('Video Session: Transient Hits under Live Masking', () => {
  it('answers a low-confidence unsafe live sample with an immediate re-sample instead of a mask', () => {
    const { last, state } = run([{ type: 'play' }, { type: 'liveSample', sampleId: 'a', verdict: 'tentative' }]);

    expect(last).toEqual([{ kind: 'requestLiveSample' }]);
    expect(state.heldTentative).toBe('a');
  });

  it('masks at once when the re-sample is unsafe too', () => {
    const { last } = run([
      { type: 'play' },
      { type: 'liveSample', sampleId: 'a', verdict: 'tentative' },
      { type: 'liveSample', sampleId: 'b', verdict: 'tentative' },
    ]);

    expect(last).toEqual(
      expect.arrayContaining([
        { kind: 'commitSample', sampleId: 'a' },
        { kind: 'commitSample', sampleId: 'b' },
        { kind: 'transientResolved', resolution: 'confirmed' },
      ]),
    );
  });

  it('drops the held sample when the re-sample is clean', () => {
    const { last } = run([
      { type: 'play' },
      { type: 'liveSample', sampleId: 'a', verdict: 'tentative' },
      { type: 'liveSample', sampleId: 'b', verdict: 'clean' },
    ]);

    expect(last).toEqual(
      expect.arrayContaining([
        { kind: 'discardSample', sampleId: 'a' },
        { kind: 'commitSample', sampleId: 'b' },
        { kind: 'transientResolved', resolution: 'suppressed' },
      ]),
    );
    expect(last).not.toContainEqual({ kind: 'commitSample', sampleId: 'a' });
  });

  it('masks a Confident Hit instantly', () => {
    const { last } = run([{ type: 'play' }, { type: 'liveSample', sampleId: 'a', verdict: 'confident' }]);

    expect(last).toContainEqual({ kind: 'commitSample', sampleId: 'a' });
    expect(kinds(last)).not.toContain('requestLiveSample');
  });
});

describe('Video Session: status', () => {
  it('stays safe while an unsafe lookahead verdict waits ahead, and flips when its span is presented', () => {
    const { effects } = run([
      { type: 'tapReachable' },
      { type: 'verdict', sampleId: 'clean-0' },
      { type: 'verdict', sampleId: 'unsafe-ahead' },
      { type: 'presented', unsafe: true },
      { type: 'presented', unsafe: false },
    ]);

    const statuses = effects.map(step => step.filter(effect => effect.kind === 'setStatus'));
    expect(statuses).toEqual([
      [],
      [{ kind: 'setStatus', status: 'safe' }],
      [],
      [{ kind: 'setStatus', status: 'unsafe' }],
      [{ kind: 'setStatus', status: 'safe' }],
    ]);
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
    expect(kinds(run([{ type: 'liveSample', sampleId: 'a', verdict: 'clean' }]).last)).toContain('clearBlur');
  });

  it('releases it only once', () => {
    const { last } = run([
      { type: 'verdict', sampleId: 'a' },
      { type: 'verdict', sampleId: 'b' },
    ]);

    expect(kinds(last)).not.toContain('clearBlur');
  });
});

describe('Video Session: tainted page pixels', () => {
  const taint = { type: 'liveCaptureFailed', permanent: true } as const;

  it('finalizes as skipped and un-blurred when no Bitstream Tap is reachable', () => {
    const { state, all } = run([taint, { type: 'tapUnreachable' }]);

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
      taint,
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
