import { describe, expect, it } from 'vitest';

import {
  createVideoSession,
  ERROR_RETRY_COOLDOWN_MS,
  MAX_CONSECUTIVE_ERRORS,
  reduce,
  RELIEVED_SAMPLE_FLOOR_MS,
  SAMPLE_TIMEOUT_MS,
  THUMBNAIL_TIMEOUT_MS,
  WATCHDOG_MS,
  type SessionEvent,
  type VideoSessionState,
} from '@/entrypoints/content/video/session/machine';

type TimelineEvent = Extract<SessionEvent, { type: 'frameAvailable' | 'seeked' }>;
type TestSessionEvent = Exclude<SessionEvent, TimelineEvent> | Omit<TimelineEvent, 'timestampSec'> | TimelineEvent;

/** Run a sequence of events through the reducer, returning the final state and all effects. */
function run(state: VideoSessionState, ...events: TestSessionEvent[]) {
  let current = state;
  const effects = [];
  for (const candidate of events) {
    const event = (
      (candidate.type === 'frameAvailable' || candidate.type === 'seeked') && !('timestampSec' in candidate)
        ? { ...candidate, timestampSec: candidate.at / 1000 }
        : candidate
    ) as SessionEvent;
    const result = reduce(current, event);
    current = result.state;
    // Most state-machine tests predate timeline-bearing send effects and only
    // care that an index was scheduled. A dedicated test below covers the
    // timestamp contract without obscuring those existing assertions.
    effects.push(
      ...result.effects.map(effect =>
        effect.kind === 'sendSample' ? { kind: effect.kind, frameIndex: effect.frameIndex } : effect,
      ),
    );
  }
  return { state: current, effects };
}

describe('VideoSession machine', () => {
  it('carries the selected media time into immediate and remembered Frame Samples', () => {
    const ready = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 10 },
    ).state;

    const immediate = reduce(ready, { type: 'seeked', at: 20, timestampSec: 12.345 });
    expect(immediate.effects).toContainEqual({ kind: 'sendSample', frameIndex: 0, timestampSec: 12.345 });

    const remembered = reduce(immediate.state, { type: 'seeked', at: 30, timestampSec: 27.5 });
    expect(remembered.state.pendingSeekTimestampSec).toBe(27.5);
    const released = reduce(remembered.state, {
      type: 'predictionReceived',
      frameIndex: 0,
      unsafe: false,
      at: 40,
    });
    expect(released.effects).toContainEqual({ kind: 'sendSample', frameIndex: 1, timestampSec: 27.5 });
    expect(released.state.pendingSeekTimestampSec).toBeNull();
  });

  it('blurs on adoption and captures the Thumbnail once its source is ready', () => {
    const born = createVideoSession();
    expect(born.effects).toContainEqual({ kind: 'applyBlur' });
    expect(born.state.phase).toBe('adopted');

    const { state, effects } = run(born.state, { type: 'thumbnailSourceReady' });
    expect(effects).toContainEqual({ kind: 'captureThumbnail' });
    expect(state.phase).toBe('thumbnailing');
  });

  it('starts the fail-closed timeout only at the first actual send', () => {
    const born = createVideoSession();

    // No send yet — a blank preload="none" player must never time into a stuck blur.
    const idle = run(born.state, { type: 'thumbnailSourceReady' });
    expect(idle.effects.filter(e => e.kind === 'startTimer')).toHaveLength(0);

    const sent = run(idle.state, { type: 'sampleSent', frameIndex: -1, at: 1000 });
    expect(sent.effects).toContainEqual({ kind: 'startTimer', timer: 'thumbnailTimeout', ms: THUMBNAIL_TIMEOUT_MS });
  });

  it('frees an inference slot when capture is cancelled before transport', () => {
    const ready = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 10 },
      { type: 'play', at: 20 },
      { type: 'frameAvailable', at: 30 },
    ).state;

    expect(ready.inflightIndex).toBe(0);
    const cancelled = reduce(ready, { type: 'sampleCancelled', frameIndex: 0, at: 40 });
    expect(cancelled.state.inflightIndex).toBeNull();
    expect(cancelled.state.errorStreak).toBe(0);
    expect(cancelled.effects).toContainEqual({ kind: 'cancelTimer', timer: 'sampleTimeout' });
  });

  it('finalizes a safe Thumbnail verdict: unblur, mark safe, stop the clock', () => {
    const { state, effects } = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 1000 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 1200 },
    );

    expect(state.phase).toBe('standby');
    expect(effects).toContainEqual({ kind: 'cancelTimer', timer: 'thumbnailTimeout' });
    expect(effects).toContainEqual({ kind: 'clearVerdict' });
    expect(effects).toContainEqual({ kind: 'clearBlur' });
    expect(effects).toContainEqual({ kind: 'setStatus', status: 'safe' });
  });

  it('finalizes an unsafe Thumbnail verdict: mask applied, whole-blur lifted', () => {
    const { state, effects } = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 1000 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: true, at: 1200 },
    );

    expect(state.phase).toBe('standby');
    expect(effects).toContainEqual({ kind: 'applyBlur' });
    expect(effects).toContainEqual({ kind: 'applyVerdictThenClearBlur' });
    expect(effects).not.toContainEqual({ kind: 'clearBlur' });
    expect(effects).toContainEqual({ kind: 'setStatus', status: 'unsafe' });
    expect(effects).not.toContainEqual({ kind: 'clearVerdict' });
  });

  it('retries the Thumbnail once on timeout, then finalizes fail-closed with blur kept', () => {
    const sent = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 1000 },
    );

    // First timeout: one retry (covers an MV3 service-worker restart).
    const retried = run(sent.state, { type: 'timerFired', timer: 'thumbnailTimeout', at: 11_000 });
    expect(retried.effects).toContainEqual({ kind: 'captureThumbnail' });
    expect(retried.state.phase).toBe('thumbnailing');

    // Second timeout: fail-closed — blur stays on, session is not stuck in THUMBNAILING.
    const blocked = run(
      retried.state,
      { type: 'sampleSent', frameIndex: -1, at: 11_100 },
      { type: 'timerFired', timer: 'thumbnailTimeout', at: 21_100 },
    );
    expect(blocked.state.phase).toBe('standby');
    expect(blocked.effects).toContainEqual({ kind: 'setStatus', status: 'unsafe' });
    expect(blocked.effects).not.toContainEqual({ kind: 'clearBlur' });
    expect(blocked.effects.filter(e => e.kind === 'captureThumbnail')).toHaveLength(0);
  });

  it('paces SAMPLING at one in-flight Frame Sample with a floor interval', () => {
    const standby = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
    );

    const playing = run(standby.state, { type: 'play', at: 1000 }, { type: 'frameAvailable', at: 1010 });
    expect(playing.state.phase).toBe('sampling');
    expect(playing.effects).toContainEqual({ kind: 'sendSample', frameIndex: 0 });

    // In-flight slot occupied: presented frames do not trigger sends.
    const whileInflight = run(
      playing.state,
      { type: 'sampleSent', frameIndex: 0, at: 1015 },
      { type: 'frameAvailable', at: 1100 },
    );
    expect(whileInflight.effects.filter(e => e.kind === 'sendSample')).toHaveLength(0);

    // Verdict frees the slot, but the floor interval still applies.
    const freed = run(whileInflight.state, { type: 'predictionReceived', frameIndex: 0, unsafe: false, at: 1180 });
    const tooSoon = run(freed.state, { type: 'frameAvailable', at: 1200 });
    expect(tooSoon.effects.filter(e => e.kind === 'sendSample')).toHaveLength(0);

    const afterFloor = run(tooSoon.state, { type: 'frameAvailable', at: 1400 });
    expect(afterFloor.effects).toContainEqual({ kind: 'sendSample', frameIndex: 1 });
  });

  it('masks unsafe playback samples instantly (whole-blur over the warm-up) and drops Stale Predictions', () => {
    const sampling = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'frameAvailable', at: 1010 },
      { type: 'sampleSent', frameIndex: 0, at: 1015 },
    );
    // The DVR is already warming (continuous DVR starts on play), unblurred.
    expect(sampling.state.dvr).toBe('warming');
    expect(sampling.state.blurred).toBe(false);

    // An unsafe verdict mid-warm-up must cover instantly: the canvas is not
    // presenting yet, and a DOM overlay would describe a frame that moved on.
    const unsafe = run(sampling.state, { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 });
    expect(unsafe.effects).toContainEqual({ kind: 'applyBlur' });
    expect(unsafe.effects).toContainEqual({ kind: 'setStatus', status: 'unsafe' });
    expect(unsafe.effects).not.toContainEqual({ kind: 'applyVerdict' });
    expect(unsafe.effects).not.toContainEqual({ kind: 'clearBlur' });
    expect(unsafe.state.dvr).toBe('warming');
    expect(unsafe.state.blurred).toBe(true);

    // A late redelivery of the Thumbnail verdict (frame -1) is a Stale Prediction:
    // it must not clear the mask the newer unsafe sample just applied.
    const stale = run(unsafe.state, { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 1250 });
    expect(stale.effects).toHaveLength(0);
  });

  it('applies a paused (standby) unsafe verdict as a precise DOM overlay, no DVR', () => {
    const standby = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'seeked', at: 2000 },
      { type: 'sampleSent', frameIndex: 0, at: 2005 },
    );

    const unsafe = run(standby.state, { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 2200 });
    expect(unsafe.effects).toContainEqual({ kind: 'applyBlur' });
    expect(unsafe.effects).toContainEqual({ kind: 'applyVerdictThenClearBlur' });
    expect(unsafe.effects).not.toContainEqual({ kind: 'clearBlur' });
    expect(unsafe.effects).not.toContainEqual({ kind: 'startDvr' });
    expect(unsafe.state.dvr).toBe('off');
  });

  it('composites paused verdicts on the canvas while the DVR is active: no DOM overlay', () => {
    const pausedPresenting = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'frameAvailable', at: 1010 },
      { type: 'sampleSent', frameIndex: 0, at: 1015 },
      { type: 'bufferReady', at: 1100 },
      { type: 'pause', at: 1150 },
    );
    expect(pausedPresenting.state.dvr).toBe('presenting');

    // The canvas owns masking even for the frozen frame: an unsafe verdict
    // landing after the pause composites there, never as a DOM overlay.
    const unsafe = run(pausedPresenting.state, { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 });
    expect(unsafe.state.masked).toBe(true);
    expect(unsafe.effects).not.toContainEqual({ kind: 'applyVerdictThenClearBlur' });
    expect(unsafe.effects).not.toContainEqual({ kind: 'applyVerdict' });
    expect(unsafe.effects).not.toContainEqual({ kind: 'applyBlur' });
    expect(unsafe.effects).toContainEqual({ kind: 'setStatus', status: 'unsafe' });

    // Paused mid-warm-up the canvas never took over and captures stop with the
    // media clock, so bufferReady can never fire: the DVR is abandoned and the
    // precise DOM overlay takes the paused frame.
    const pausedWarming = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'frameAvailable', at: 1010 },
      { type: 'sampleSent', frameIndex: 0, at: 1015 },
      { type: 'pause', at: 1050 },
    );
    expect(pausedWarming.state.dvr).toBe('off');
    expect(pausedWarming.effects).toContainEqual({ kind: 'stopDvr' });
    const unsafeWarming = run(pausedWarming.state, {
      type: 'predictionReceived',
      frameIndex: 0,
      unsafe: true,
      at: 1200,
    });
    expect(unsafeWarming.state.masked).toBe(true);
    expect(unsafeWarming.effects).toContainEqual({ kind: 'applyVerdictThenClearBlur' });
  });

  it('clears a mask only after two consecutive clean samples (instant on, slow off)', () => {
    const masked = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 },
    );

    const oneClean = run(masked.state, { type: 'predictionReceived', frameIndex: 1, unsafe: false, at: 1500 });
    expect(oneClean.effects).not.toContainEqual({ kind: 'clearVerdict' });
    // Short of the streak, the warm-up blur is the only protection: keep it.
    expect(oneClean.effects).not.toContainEqual({ kind: 'clearBlur' });
    expect(oneClean.state.blurred).toBe(true);

    // The streak clears mask, status, and blur — this clearBlur is also the
    // un-blur path for a session whose buffer capture never succeeds (the DVR
    // stays warming forever, so bufferReady can never lift the blur).
    const twoClean = run(oneClean.state, { type: 'predictionReceived', frameIndex: 2, unsafe: false, at: 1800 });
    expect(twoClean.effects).toContainEqual({ kind: 'clearVerdict' });
    expect(twoClean.effects).toContainEqual({ kind: 'clearBlur' });
    expect(twoClean.effects).toContainEqual({ kind: 'setStatus', status: 'safe' });
    // Continuous DVR: a clean streak never exits the presentation.
    expect(twoClean.effects).not.toContainEqual({ kind: 'stopDvr' });
    expect(twoClean.state.dvr).toBe('warming');
    expect(twoClean.state.blurred).toBe(false);

    // An unsafe sample resets the clean streak and re-covers the warm-up.
    const reMasked = run(twoClean.state, { type: 'predictionReceived', frameIndex: 3, unsafe: true, at: 2100 });
    expect(reMasked.effects).not.toContainEqual({ kind: 'startDvr' });
    expect(reMasked.effects).toContainEqual({ kind: 'applyBlur' });
    expect(reMasked.state.dvr).toBe('warming');
    const cleanAgain = run(reMasked.state, { type: 'predictionReceived', frameIndex: 4, unsafe: false, at: 2400 });
    expect(cleanAgain.effects).not.toContainEqual({ kind: 'clearVerdict' });
  });

  it('runs the DVR lifecycle: warm-up blur, bufferReady swap, pause freeze, dispose teardown', () => {
    const warming = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 },
    );
    expect(warming.state.dvr).toBe('warming');

    // Buffer spans D: the canvas takes over; blur and DOM overlay swap out.
    const presenting = run(warming.state, { type: 'bufferReady', at: 2800 });
    expect(presenting.state.dvr).toBe('presenting');
    expect(presenting.effects).toContainEqual({ kind: 'clearBlur' });
    expect(presenting.effects).toContainEqual({ kind: 'clearVerdict' });

    // While presenting: no DOM overlay work per verdict — the player composites.
    const nextUnsafe = run(presenting.state, { type: 'predictionReceived', frameIndex: 1, unsafe: true, at: 3000 });
    expect(nextUnsafe.effects).not.toContainEqual({ kind: 'applyVerdict' });
    expect(nextUnsafe.effects).not.toContainEqual({ kind: 'applyBlur' });
    expect(nextUnsafe.state.dvr).toBe('presenting');

    // Watchdog silence while presenting: the player already fails closed per frame.
    const silent = run(nextUnsafe.state, { type: 'timerFired', timer: 'watchdog', at: 9000 });
    expect(silent.effects).toHaveLength(0);

    // Pause: the canvas freezes on the delayed frame; the DVR never hands
    // back to the DOM overlay. Sampling bookkeeping winds down, and the delay
    // line is dropped so its tail cannot drain over the frozen frame.
    const paused = run(nextUnsafe.state, { type: 'pause', at: 4000 });
    expect(paused.state.phase).toBe('standby');
    expect(paused.state.dvr).toBe('presenting');
    expect(paused.effects).toEqual([{ kind: 'cancelTimer', timer: 'watchdog' }, { kind: 'holdAudioDelay' }]);

    // Resume from the frozen frame: presentation continues, no re-warm, no
    // blur — but the delay line the pause discarded comes back.
    const resumed = run(paused.state, { type: 'play', at: 4500 });
    expect(resumed.state.phase).toBe('sampling');
    expect(resumed.state.dvr).toBe('presenting');
    expect(resumed.effects).not.toContainEqual({ kind: 'startDvr' });
    expect(resumed.effects).not.toContainEqual({ kind: 'applyBlur' });
    expect(resumed.effects).toContainEqual({ kind: 'resumeAudioDelay' });

    // Dispose mid-presentation: stopDvr and cleanup exactly once.
    const disposed = run(nextUnsafe.state, { type: 'dispose' });
    expect(disposed.effects.filter(e => e.kind === 'stopDvr')).toHaveLength(1);
    expect(disposed.effects.filter(e => e.kind === 'cleanup')).toHaveLength(1);
    const afterDispose = run(disposed.state, { type: 'bufferReady', at: 5000 });
    expect(afterDispose.effects).toHaveLength(0);
  });

  it('finalizes safe when the first clean verdict arrives after bufferReady lifted the blur', () => {
    // bufferReady beats the first inference round-trip on the common path
    // (~100 ms vs ~1 s+): the blur is already gone, but the first verdict must
    // still land a status attribute.
    const presenting = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'play', at: 100 },
      { type: 'bufferReady', at: 300 },
    );
    expect(presenting.state.dvr).toBe('presenting');
    expect(presenting.state.blurred).toBe(false);

    const clean = run(presenting.state, { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 1200 });
    expect(clean.effects).toContainEqual({ kind: 'setStatus', status: 'safe' });
  });

  it('releases the DVR on viewport suspension with the DOM hand-back pause used to do', () => {
    const presenting = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: true, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'bufferReady', at: 2800 },
    );
    expect(presenting.state.dvr).toBe('presenting');
    expect(presenting.state.masked).toBe(true);

    // Scrolled away mid-playback: the ring releases, and the masked native
    // element is covered until its static overlay paints.
    const suspended = run(presenting.state, { type: 'suspend', at: 4000 });
    expect(suspended.state.phase).toBe('standby');
    expect(suspended.state.dvr).toBe('off');
    expect(suspended.effects).toContainEqual({ kind: 'cancelTimer', timer: 'watchdog' });
    expect(suspended.effects).toContainEqual({ kind: 'stopDvr' });
    expect(suspended.effects).toContainEqual({ kind: 'applyBlur' });
    expect(suspended.effects).toContainEqual({ kind: 'applyVerdictThenClearBlur' });

    // A DVR frozen by pause releases the same way when it leaves the viewport.
    const paused = run(presenting.state, { type: 'pause', at: 4000 });
    expect(paused.state.dvr).toBe('presenting');
    const suspendedPaused = run(paused.state, { type: 'suspend', at: 5000 });
    expect(suspendedPaused.state.dvr).toBe('off');
    expect(suspendedPaused.effects).toContainEqual({ kind: 'stopDvr' });
  });

  it('drains the buffered tail on ended instead of stopping the DVR', () => {
    const presenting = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: true, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'bufferReady', at: 2800 },
    );
    expect(presenting.state.dvr).toBe('presenting');

    const ended = run(presenting.state, { type: 'ended', at: 9000 });
    expect(ended.state.phase).toBe('standby');
    expect(ended.state.dvr).toBe('presenting');
    expect(ended.effects).toContainEqual({ kind: 'drainDvr' });
    expect(ended.effects).not.toContainEqual({ kind: 'stopDvr' });
    expect(ended.effects).not.toContainEqual({ kind: 'applyVerdictThenClearBlur' });

    // Chrome fires 'pause' just before 'ended' at the natural end: the pause
    // freeze must not swallow the drain, and must not drop the delay line —
    // its buffered audio is the soundtrack of the tail the drain replays.
    const pausedFirst = run(presenting.state, { type: 'pause', at: 9000, atEnd: true }, { type: 'ended', at: 9001 });
    expect(pausedFirst.state.dvr).toBe('presenting');
    expect(pausedFirst.effects).toContainEqual({ kind: 'drainDvr' });
    expect(pausedFirst.effects).not.toContainEqual({ kind: 'stopDvr' });
    expect(pausedFirst.effects).not.toContainEqual({ kind: 'holdAudioDelay' });
  });

  it('hands a still-warming DVR back to the DOM on ended: there is no tail to drain', () => {
    // The canvas never took over (capture failed / sub-frame video): a drain
    // has nothing to consume and bufferReady can never fire after ended, so
    // the whole-blur would latch forever. The old hand-back path applies.
    const warming = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: true, at: 100 },
      { type: 'play', at: 1000 },
    );
    expect(warming.state.dvr).toBe('warming');

    const ended = run(warming.state, { type: 'ended', at: 9000 });
    expect(ended.state.phase).toBe('standby');
    expect(ended.state.dvr).toBe('off');
    expect(ended.effects).not.toContainEqual({ kind: 'drainDvr' });
    expect(ended.effects).toContainEqual({ kind: 'stopDvr' });
    expect(ended.effects).toContainEqual({ kind: 'applyBlur' });
    expect(ended.effects).toContainEqual({ kind: 'applyVerdictThenClearBlur' });
  });

  it('keeps a presenting DVR latched across clean streaks: the presentation never exits', () => {
    const presenting = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 },
      { type: 'bufferReady', at: 1300 },
    );

    const clean = run(
      presenting.state,
      { type: 'predictionReceived', frameIndex: 1, unsafe: false, at: 1500 },
      { type: 'predictionReceived', frameIndex: 2, unsafe: false, at: 1800 },
    );
    expect(clean.state.masked).toBe(false);
    expect(clean.state.dvr).toBe('presenting');
    expect(clean.effects).toContainEqual({ kind: 'clearVerdict' });
    expect(clean.effects).toContainEqual({ kind: 'setStatus', status: 'safe' });
    expect(clean.effects).not.toContainEqual({ kind: 'stopDvr' });
    // No teardown is armed either: the only timers here are watchdog rewinds.
    expect(clean.effects.filter(e => e.kind === 'startTimer').every(e => e.timer === 'watchdog')).toBe(true);

    // A later unsafe verdict composites into the running presentation: no
    // re-warm, no DOM effects, no visible mode switch.
    const unsafeAgain = run(clean.state, {
      type: 'predictionReceived',
      frameIndex: 3,
      unsafe: true,
      at: 2100,
    });
    expect(unsafeAgain.state.dvr).toBe('presenting');
    expect(unsafeAgain.effects).not.toContainEqual({ kind: 'startDvr' });
    expect(unsafeAgain.effects).not.toContainEqual({ kind: 'applyBlur' });
  });

  it('re-warms the DVR on a mid-presentation seek (buffer discontinuity)', () => {
    const presenting = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 },
      { type: 'bufferReady', at: 2800 },
    );

    const seeked = run(presenting.state, { type: 'seeked', at: 3500 });
    expect(seeked.state.dvr).toBe('warming');
    expect(seeked.state.blurred).toBe(true);
    expect(seeked.effects).toContainEqual({ kind: 'applyBlur' });
    expect(seeked.effects).toContainEqual({ kind: 'stopDvr' });
    expect(seeked.effects).toContainEqual({ kind: 'startDvr' });
    // The post-seek frame is still sampled immediately (floor waived).
    expect(seeked.effects).toContainEqual({ kind: 'sendSample', frameIndex: 0 });
  });

  it('re-warms without blur on a mid-presentation seek of a safe session', () => {
    const safePresenting = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'bufferReady', at: 2800 },
    );
    expect(safePresenting.state.dvr).toBe('presenting');
    expect(safePresenting.state.masked).toBe(false);

    // Same flush + re-warm as a masked seek, but the safe verdict means no
    // fail-closed cover: the pinned frame is the warm-up presentation.
    const seeked = run(safePresenting.state, { type: 'seeked', at: 3500 });
    expect(seeked.state.dvr).toBe('warming');
    expect(seeked.effects).toContainEqual({ kind: 'stopDvr' });
    expect(seeked.effects).toContainEqual({ kind: 'startDvr' });
    expect(seeked.effects).not.toContainEqual({ kind: 'applyBlur' });
    expect(seeked.state.blurred).toBe(false);
    expect(seeked.effects).toContainEqual({ kind: 'sendSample', frameIndex: 0 });

    // Presenting again after the re-warm: swap effects only, no timers armed.
    const rePresenting = run(seeked.state, { type: 'bufferReady', at: 5000 });
    expect(rePresenting.state.dvr).toBe('presenting');
    expect(rePresenting.effects).toEqual([{ kind: 'clearVerdict' }, { kind: 'clearBlur' }]);
  });

  it('restores the fail-closed cover when a seek tears down a verdict-less presentation', () => {
    // Play preempted the Thumbnail: the session presents verdict-less, the
    // canvas whole-blurs verdict-late frames itself. A seek stops that canvas,
    // so the DOM blur must return before the native element shows.
    const verdictlessPresenting = run(
      createVideoSession().state,
      { type: 'play', at: 50 },
      { type: 'bufferReady', at: 2800 },
    );
    expect(verdictlessPresenting.state.dvr).toBe('presenting');
    expect(verdictlessPresenting.state.blurred).toBe(false);

    const seeked = run(verdictlessPresenting.state, { type: 'seeked', at: 3500 });
    expect(seeked.state.dvr).toBe('warming');
    expect(seeked.effects).toContainEqual({ kind: 'applyBlur' });
    expect(seeked.state.blurred).toBe(true);
  });

  it('does not blur a seek re-warm on a resumed skipped session (allow stance preserved)', () => {
    const failing = run(
      createVideoSession().state,
      { type: 'play', at: 50 },
      { type: 'frameAvailable', at: 60 },
      { type: 'sampleSent', frameIndex: 0, at: 65 },
    );
    let errored = failing.state;
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      errored = run(errored, { type: 'sendFailed', frameIndex: 0, at: 5000 + i }).state;
    }
    const resumed = run(
      errored,
      { type: 'timerFired', timer: 'errorCooldown', at: 40_000 },
      { type: 'play', at: 40_010 },
    );
    expect(resumed.state.dvr).toBe('warming');
    expect(resumed.state.blurred).toBe(false);

    // Still verdict-less, but deliberately allowed (status skipped): a seek
    // must not resurrect the blur the finalize deliberately cleared.
    const seeked = run(resumed.state, { type: 'seeked', at: 40_500 });
    expect(seeked.state.dvr).toBe('warming');
    expect(seeked.effects).not.toContainEqual({ kind: 'applyBlur' });
    expect(seeked.state.blurred).toBe(false);
  });

  it('starts the DVR when a masked (poster-verdicted) video begins playing', () => {
    const maskedStandby = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: true, at: 100 },
    );
    expect(maskedStandby.state.masked).toBe(true);
    expect(maskedStandby.state.dvr).toBe('off');

    const playing = run(maskedStandby.state, { type: 'play', at: 1000 });
    expect(playing.state.dvr).toBe('warming');
    expect(playing.effects).toContainEqual({ kind: 'applyBlur' });
    expect(playing.effects).toContainEqual({ kind: 'startDvr' });
  });

  it('starts the DVR unblurred when a safe-verdicted video begins playing', () => {
    const safeStandby = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
    );
    expect(safeStandby.state.dvr).toBe('off');

    const playing = run(safeStandby.state, { type: 'play', at: 1000 });
    expect(playing.state.dvr).toBe('warming');
    expect(playing.effects).toContainEqual({ kind: 'startDvr' });
    // Safe warm-up is uncovered on purpose: the pinned earliest frame is the cover.
    expect(playing.effects).not.toContainEqual({ kind: 'applyBlur' });
    expect(playing.state.blurred).toBe(false);
  });

  it('keeps the adoption blur when a verdict-less video begins playing (fail-closed warm-up)', () => {
    const eager = run(createVideoSession().state, { type: 'thumbnailSourceReady' }, { type: 'play', at: 50 });
    expect(eager.state.phase).toBe('sampling');
    expect(eager.state.dvr).toBe('warming');
    expect(eager.effects).toContainEqual({ kind: 'startDvr' });
    expect(eager.effects).not.toContainEqual({ kind: 'clearBlur' });
    expect(eager.state.blurred).toBe(true);
  });

  it('re-blurs fail-closed when verdicts go silent mid-playback, and self-heals on the next verdict', () => {
    const playing = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
    );
    expect(playing.effects).toContainEqual({ kind: 'startTimer', timer: 'watchdog', ms: WATCHDOG_MS });

    // Verdicts flowing: each one rewinds the watchdog.
    const flowing = run(playing.state, { type: 'predictionReceived', frameIndex: 0, unsafe: false, at: 1300 });
    expect(flowing.effects).toContainEqual({ kind: 'startTimer', timer: 'watchdog', ms: WATCHDOG_MS });

    // Silence: watchdog fires -> whole-video blur returns, sampling continues.
    const silent = run(flowing.state, { type: 'timerFired', timer: 'watchdog', at: 6300 });
    expect(silent.effects).toContainEqual({ kind: 'applyBlur' });
    expect(silent.state.phase).toBe('sampling');

    // Recovery: the next verdict lifts the blur without waiting for the hysteresis streak.
    const healed = run(silent.state, { type: 'predictionReceived', frameIndex: 1, unsafe: false, at: 8000 });
    expect(healed.effects).toContainEqual({ kind: 'clearBlur' });
  });

  it('frees the in-flight slot when a sample verdict never returns', () => {
    const inflight = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'frameAvailable', at: 1010 },
      { type: 'sampleSent', frameIndex: 0, at: 1015 },
    );
    expect(inflight.effects).toContainEqual({ kind: 'startTimer', timer: 'sampleTimeout', ms: SAMPLE_TIMEOUT_MS });

    // Slot occupied, verdict lost: frames pass without sends until the timeout frees it.
    const stalled = run(inflight.state, { type: 'frameAvailable', at: 2000 });
    expect(stalled.effects.filter(e => e.kind === 'sendSample')).toHaveLength(0);

    const recovered = run(
      stalled.state,
      { type: 'timerFired', timer: 'sampleTimeout', at: 4015 },
      { type: 'frameAvailable', at: 4020 },
    );
    expect(recovered.effects).toContainEqual({ kind: 'sendSample', frameIndex: 1 });
  });

  it('captures a one-shot sample on seek, even while paused, and applies its verdict', () => {
    const standby = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
    );

    // Paused scrub: the displayed frame changed, so it must be sampled and its verdict applied.
    const scrubbed = run(standby.state, { type: 'seeked', at: 2000 });
    expect(scrubbed.effects).toContainEqual({ kind: 'sendSample', frameIndex: 0 });
    expect(scrubbed.state.phase).toBe('standby');

    const verdict = run(
      scrubbed.state,
      { type: 'sampleSent', frameIndex: 0, at: 2005 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 2200 },
    );
    expect(verdict.effects).toContainEqual({ kind: 'applyVerdictThenClearBlur' });

    // Mid-playback seek bypasses the floor interval.
    const seekWhilePlaying = run(
      verdict.state,
      { type: 'play', at: 3000 },
      { type: 'frameAvailable', at: 3010 },
      { type: 'sampleSent', frameIndex: 1, at: 3015 },
      { type: 'predictionReceived', frameIndex: 1, unsafe: true, at: 3100 },
      { type: 'seeked', at: 3150 },
    );
    expect(seekWhilePlaying.effects).toContainEqual({ kind: 'sendSample', frameIndex: 2 });
  });

  it('returns to STANDBY on pause/ended and silences the watchdog', () => {
    const sampling = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
    );

    const paused = run(sampling.state, { type: 'pause', at: 2000 });
    expect(paused.state.phase).toBe('standby');
    expect(paused.effects).toContainEqual({ kind: 'cancelTimer', timer: 'watchdog' });

    const ended = run(paused.state, { type: 'play', at: 3000 }, { type: 'ended', at: 9000 });
    expect(ended.state.phase).toBe('standby');
    expect(ended.effects).toContainEqual({ kind: 'cancelTimer', timer: 'watchdog' });
  });

  it('finalizes as allow after consecutive send failures; success resets the streak', () => {
    const sampling = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
    );

    // A verdict between failures resets the consecutive-error count.
    let interrupted = sampling.state;
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS - 1; i++) {
      interrupted = run(interrupted, { type: 'sendFailed', frameIndex: 0, at: 2000 + i }).state;
    }
    interrupted = run(
      interrupted,
      { type: 'predictionReceived', frameIndex: 0, unsafe: false, at: 3000 },
      { type: 'sendFailed', frameIndex: 0, at: 3100 },
    ).state;
    expect(interrupted.phase).toBe('sampling');

    // An unbroken run of failures gives up as allow: inference-impossible is
    // not unsafe, so the video plays un-blurred with status `skipped`.
    let failing = sampling.state;
    let lastEffects;
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      const result = run(failing, { type: 'sendFailed', frameIndex: 0, at: 5000 + i });
      failing = result.state;
      lastEffects = result.effects;
    }
    expect(failing.phase).toBe('error');
    expect(lastEffects).toContainEqual({ kind: 'clearBlur' });
    expect(lastEffects).toContainEqual({ kind: 'clearVerdict' });
    expect(lastEffects).toContainEqual({ kind: 'setStatus', status: 'skipped' });
    expect(lastEffects).toContainEqual({ kind: 'stopTicker' });
    expect(lastEffects).toContainEqual({ kind: 'cancelTimer', timer: 'watchdog' });
    expect(lastEffects).not.toContainEqual({ kind: 'applyBlur' });
    // A transient streak is an outage, not an impossibility: a retry is armed.
    expect(lastEffects).toContainEqual({
      kind: 'startTimer',
      timer: 'errorCooldown',
      ms: ERROR_RETRY_COOLDOWN_MS,
    });

    // While resting: presented frames no longer trigger sends.
    const afterError = run(failing, { type: 'frameAvailable', at: 9000 });
    expect(afterError.effects).toHaveLength(0);
  });

  it('retries after the error cooldown: standby, ticker resumed, sampling recovers', () => {
    const sampling = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
    );
    let failing = sampling.state;
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      failing = run(failing, { type: 'sendFailed', frameIndex: 0, at: 5000 + i }).state;
    }
    expect(failing.phase).toBe('error');

    // Cooldown expiry: clean slate; the adapter restarts the ticker and
    // synthesizes 'play' for a still-playing video.
    const rested = run(failing, { type: 'timerFired', timer: 'errorCooldown', at: 40_000 });
    expect(rested.state.phase).toBe('standby');
    expect(rested.state.errorStreak).toBe(0);
    expect(rested.effects).toContainEqual({ kind: 'resumeTicker' });

    const resumed = run(rested.state, { type: 'play', at: 40_010 }, { type: 'frameAvailable', at: 40_020 });
    expect(resumed.state.phase).toBe('sampling');
    expect(resumed.effects).toContainEqual({ kind: 'sendSample', frameIndex: 0 });
    // Re-entering SAMPLING restarts the continuous DVR; the skipped session
    // stays unblurred until a fresh verdict says otherwise.
    expect(resumed.state.dvr).toBe('warming');
    expect(resumed.effects).toContainEqual({ kind: 'startDvr' });
    expect(resumed.effects).not.toContainEqual({ kind: 'applyBlur' });

    // A second unbroken streak rests again — the retry loop is indefinite.
    let failingAgain = resumed.state;
    let secondEffects;
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      const result = run(failingAgain, { type: 'sendFailed', frameIndex: 0, at: 50_000 + i });
      failingAgain = result.state;
      secondEffects = result.effects;
    }
    expect(failingAgain.phase).toBe('error');
    expect(secondEffects).toContainEqual({
      kind: 'startTimer',
      timer: 'errorCooldown',
      ms: ERROR_RETRY_COOLDOWN_MS,
    });
  });

  it('finalizes as allow immediately when a sample capture fails permanently', () => {
    const sampling = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'frameAvailable', at: 1010 },
      { type: 'sampleSent', frameIndex: 0, at: 1015 },
    );

    // Canvas taint: no amount of retries can ever capture this source.
    const { state, effects } = run(sampling.state, { type: 'sendFailed', frameIndex: 0, at: 1100, permanent: true });
    expect(state.phase).toBe('error');
    expect(effects).toContainEqual({ kind: 'clearBlur' });
    expect(effects).toContainEqual({ kind: 'setStatus', status: 'skipped' });
    expect(effects).toContainEqual({ kind: 'stopTicker' });
    expect(effects).not.toContainEqual({ kind: 'applyBlur' });
    // Permanent means permanent: no retry is armed.
    expect(effects.filter(e => e.kind === 'startTimer')).toHaveLength(0);
  });

  it('cancels the sample timeout when the in-flight verdict arrives', () => {
    const verdict = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'frameAvailable', at: 1010 },
      { type: 'sampleSent', frameIndex: 0, at: 1015 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: false, at: 2990 },
    );
    // Without the cancel, the 1015+3000ms timer could fire under the NEXT
    // in-flight sample and break the one-in-flight invariant.
    expect(verdict.effects).toContainEqual({ kind: 'cancelTimer', timer: 'sampleTimeout' });
  });

  it('does not free a live sample slot when an unrelated send fails', () => {
    // Play preempts the Thumbnail; sample 0 goes in flight; then the Thumbnail
    // capture fails. That failure must not free sample 0's slot.
    const inflight = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'play', at: 50 },
      { type: 'frameAvailable', at: 60 },
      { type: 'sampleSent', frameIndex: 0, at: 65 },
      { type: 'sendFailed', frameIndex: -1, at: 70 }, // Thumbnail capture failed
    );

    const stillInflight = run(inflight.state, { type: 'frameAvailable', at: 400 });
    expect(stillInflight.effects.filter(e => e.kind === 'sendSample')).toHaveLength(0);

    // The matching failure does free it.
    const freed = run(
      inflight.state,
      { type: 'sendFailed', frameIndex: 0, at: 400 },
      { type: 'frameAvailable', at: 700 },
    );
    expect(freed.effects).toContainEqual({ kind: 'sendSample', frameIndex: 1 });
  });

  it('disposes terminally on source change: cleanup once, then dead silence', () => {
    const sampling = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: true, at: 100 },
      { type: 'play', at: 1000 },
    );

    const disposed = run(sampling.state, { type: 'dispose' });
    expect(disposed.state.phase).toBe('disposed');
    expect(disposed.effects).toContainEqual({ kind: 'cleanup' });

    // A dead session must never resurrect: no sends, no verdict application, no timers.
    const afterDispose = run(
      disposed.state,
      { type: 'play', at: 2000 },
      { type: 'frameAvailable', at: 2010 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 2200 },
      { type: 'timerFired', timer: 'watchdog', at: 9000 },
    );
    expect(afterDispose.effects).toHaveLength(0);
    expect(afterDispose.state.phase).toBe('disposed');
  });

  it('still captures a Thumbnail for an active session that has no verdict yet', () => {
    // Adopted while already playing: 'play' preempts THUMBNAILING entirely.
    const playingFirst = run(createVideoSession().state, { type: 'play', at: 10 });
    expect(playingFirst.state.phase).toBe('sampling');

    // Thumbnail readiness arrives afterwards; without this, a pause before the
    // first sample verdict would leave the video blurred in STANDBY forever.
    const ready = run(playingFirst.state, { type: 'thumbnailSourceReady' });
    expect(ready.effects).toContainEqual({ kind: 'captureThumbnail' });

    // But once any verdict has been applied, late readiness signals do nothing.
    const verdicted = run(
      ready.state,
      { type: 'sampleSent', frameIndex: -1, at: 50 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 300 },
      { type: 'thumbnailSourceReady' },
    );
    expect(verdicted.effects.filter(e => e.kind === 'captureThumbnail')).toHaveLength(0);
  });

  it('lifts the adoption blur when play preempts the Thumbnail and the first sample is clean', () => {
    const eager = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'play', at: 50 }, // user hits play before the Thumbnail verdict returns
      { type: 'frameAvailable', at: 60 },
      { type: 'sampleSent', frameIndex: 0, at: 65 },
    );
    expect(eager.state.phase).toBe('sampling');

    const clean = run(eager.state, { type: 'predictionReceived', frameIndex: 0, unsafe: false, at: 300 });
    expect(clean.effects).toContainEqual({ kind: 'clearBlur' });
    expect(clean.effects).toContainEqual({ kind: 'setStatus', status: 'safe' });
  });

  it('remembers a seek during THUMBNAILING: blur is kept and the post-seek frame is sampled', () => {
    const scrubbedDuringThumbnail = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'seeked', at: 500 }, // paused scrub while the Thumbnail verdict is in flight
    );
    expect(scrubbedDuringThumbnail.effects.filter(e => e.kind === 'sendSample')).toHaveLength(0);

    // The clean Thumbnail verdict describes a frame that is no longer displayed:
    // it must NOT unblur, and the post-seek frame must be sampled immediately.
    const verdict = run(scrubbedDuringThumbnail.state, {
      type: 'predictionReceived',
      frameIndex: -1,
      unsafe: false,
      at: 800,
    });
    expect(verdict.effects).not.toContainEqual({ kind: 'clearBlur' });
    expect(verdict.effects).toContainEqual({ kind: 'sendSample', frameIndex: 0 });

    const postSeek = run(
      verdict.state,
      { type: 'sampleSent', frameIndex: 0, at: 810 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: false, at: 1100 },
    );
    expect(postSeek.effects).toContainEqual({ kind: 'clearBlur' });
    expect(postSeek.effects).toContainEqual({ kind: 'setStatus', status: 'safe' });
  });

  it('remembers a seek while a sample is in flight and fires it once the slot frees', () => {
    const inflight = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'seeked', at: 2000 }, // paused scrub -> one-shot sample 0 in flight
      { type: 'sampleSent', frameIndex: 0, at: 2005 },
      { type: 'seeked', at: 2100 }, // second scrub while the first is in flight
    );
    expect(inflight.effects.filter(e => e.kind === 'sendSample')).toHaveLength(1);

    // The verdict for the pre-seek position frees the slot; the pending seek fires.
    const freed = run(inflight.state, { type: 'predictionReceived', frameIndex: 0, unsafe: false, at: 2300 });
    expect(freed.effects).toContainEqual({ kind: 'sendSample', frameIndex: 1 });
  });

  it('finalizes as allow when the Thumbnail capture fails permanently (no retry loop)', () => {
    const thumbnailing = run(createVideoSession().state, { type: 'thumbnailSourceReady' });
    const { state, effects } = run(
      thumbnailing.state,
      { type: 'sendFailed', frameIndex: -1, at: 100, permanent: true }, // CORS-tainted canvas
    );
    expect(state.phase).toBe('error');
    expect(effects).toContainEqual({ kind: 'clearBlur' });
    expect(effects).toContainEqual({ kind: 'clearVerdict' });
    expect(effects).toContainEqual({ kind: 'setStatus', status: 'skipped' });
    expect(effects).toContainEqual({ kind: 'stopTicker' });
    expect(effects).not.toContainEqual({ kind: 'captureThumbnail' });
    expect(effects).not.toContainEqual({ kind: 'applyBlur' });

    // Terminal: playback does not resurrect sampling for an un-analyzable source.
    const played = run(state, { type: 'play', at: 2000 }, { type: 'frameAvailable', at: 2010 });
    expect(played.effects).toHaveLength(0);
  });

  it('falls back to STANDBY fail-closed when the Thumbnail capture fails transiently, still playable', () => {
    const failed = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sendFailed', frameIndex: -1, at: 100 }, // no frame data yet / zero dimensions
    );
    expect(failed.state.phase).toBe('standby');
    expect(failed.effects).not.toContainEqual({ kind: 'clearBlur' });
    // The attempt is finalized: exactly one processed-status attribute must
    // land even on this path, and fail-closed means it reads unsafe.
    expect(failed.effects).toContainEqual({ kind: 'setStatus', status: 'unsafe' });

    // The session self-heals: playback sampling can still deliver a verdict later.
    const played = run(failed.state, { type: 'play', at: 2000 }, { type: 'frameAvailable', at: 2010 });
    expect(played.effects).toContainEqual({ kind: 'sendSample', frameIndex: 0 });
  });

  it('finalizes skipped at adoption when audio is undelayable: nothing is ever spent', () => {
    const { state, effects } = run(createVideoSession().state, { type: 'audioUndelayable', at: 0 });
    expect(state.phase).toBe('error');
    expect(effects).toContainEqual({ kind: 'clearBlur' });
    expect(effects).toContainEqual({ kind: 'setStatus', status: 'skipped' });
    // Terminal, not an outage: no cooldown may ever resurrect this session.
    expect(effects).not.toContainEqual(expect.objectContaining({ kind: 'startTimer', timer: 'errorCooldown' }));

    // No Thumbnail, no samples — the pipeline never spends anything on it.
    const later = run(
      state,
      { type: 'thumbnailSourceReady' },
      { type: 'play', at: 100 },
      { type: 'frameAvailable', at: 200 },
    );
    expect(later.effects).toHaveLength(0);
  });

  it('tears down a presenting DVR when audio capture fails permanently at engage', () => {
    const presenting = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: true, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'bufferReady', at: 2800 },
    );
    expect(presenting.state.dvr).toBe('presenting');

    const { state, effects } = run(presenting.state, { type: 'audioUndelayable', at: 3000 });
    expect(state.phase).toBe('error');
    expect(state.dvr).toBe('off');
    expect(effects).toContainEqual({ kind: 'stopDvr' });
    expect(effects).toContainEqual({ kind: 'clearVerdict' });
    expect(effects).toContainEqual({ kind: 'clearBlur' });
    expect(effects).toContainEqual({ kind: 'setStatus', status: 'skipped' });
    expect(effects).toContainEqual({ kind: 'stopTicker' });
    expect(effects).not.toContainEqual(expect.objectContaining({ kind: 'startTimer', timer: 'errorCooldown' }));

    // Terminal: playback never resurrects sampling or the DVR.
    const played = run(state, { type: 'play', at: 4000 }, { type: 'frameAvailable', at: 4010 });
    expect(played.effects).toHaveLength(0);
  });
});

describe('analysis underrun', () => {
  const presenting = () =>
    run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: true, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'bufferReady', at: 2800 },
    ).state;

  it('first underrun while presenting widens the sampling floor (relief), keeping the DVR', () => {
    const relieved = run(presenting(), { type: 'analysisUnderrun', at: 3000 });
    expect(relieved.state.samplingRelieved).toBe(true);
    expect(relieved.state.dvr).toBe('presenting');
    expect(relieved.effects).toHaveLength(0);

    // The floor widened: a frame inside the relieved interval is skipped, one past it samples.
    const first = run(relieved.state, { type: 'frameAvailable', at: 3100 });
    expect(first.effects).toContainEqual(expect.objectContaining({ kind: 'sendSample' }));
    const settled = run(
      first.state,
      { type: 'sampleSent', frameIndex: 0, at: 3110 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 3200 },
    );
    const early = run(settled.state, { type: 'frameAvailable', at: 3100 + RELIEVED_SAMPLE_FLOOR_MS - 50 });
    expect(early.effects).not.toContainEqual(expect.objectContaining({ kind: 'sendSample' }));
    const late = run(settled.state, { type: 'frameAvailable', at: 3100 + RELIEVED_SAMPLE_FLOOR_MS + 50 });
    expect(late.effects).toContainEqual(expect.objectContaining({ kind: 'sendSample' }));
  });

  it('a second sustained underrun after relief demotes out of the DVR like audioUndelayable', () => {
    const relieved = run(presenting(), { type: 'analysisUnderrun', at: 3000 }).state;
    const { state, effects } = run(relieved, { type: 'analysisUnderrun', at: 9000 });
    expect(state.phase).toBe('error');
    expect(state.dvr).toBe('off');
    expect(effects).toContainEqual({ kind: 'stopDvr' });
    expect(effects).toContainEqual({ kind: 'clearBlur' });
    expect(effects).toContainEqual({ kind: 'setStatus', status: 'skipped' });
    // Terminal for the run: no cooldown resurrects a machine that cannot keep up.
    expect(effects).not.toContainEqual(expect.objectContaining({ kind: 'startTimer', timer: 'errorCooldown' }));
  });

  it('is ignored while the DVR is off', () => {
    const standby = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
    );
    expect(standby.state.dvr).toBe('off');
    const { state, effects } = run(standby.state, { type: 'analysisUnderrun', at: 200 });
    expect(state).toEqual(standby.state);
    expect(effects).toHaveLength(0);
  });
});
