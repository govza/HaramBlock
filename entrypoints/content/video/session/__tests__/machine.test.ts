import { describe, expect, it } from 'vitest';

import {
  createVideoSession,
  DVR_IDLE_TEARDOWN_MS,
  ERROR_RETRY_COOLDOWN_MS,
  MAX_CONSECUTIVE_ERRORS,
  reduce,
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

  it('masks unsafe playback samples instantly (whole-blur + DVR) and drops Stale Predictions', () => {
    const sampling = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'frameAvailable', at: 1010 },
      { type: 'sampleSent', frameIndex: 0, at: 1015 },
    );

    // Playback masking goes through the DVR: instant whole-blur covers the
    // warm-up; a DOM overlay would describe a frame that already moved on.
    const unsafe = run(sampling.state, { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 });
    expect(unsafe.effects).toContainEqual({ kind: 'applyBlur' });
    expect(unsafe.effects).toContainEqual({ kind: 'startDvr' });
    expect(unsafe.effects).toContainEqual({ kind: 'setStatus', status: 'unsafe' });
    expect(unsafe.effects).not.toContainEqual({ kind: 'applyVerdict' });
    expect(unsafe.effects).not.toContainEqual({ kind: 'clearBlur' });
    expect(unsafe.state.dvr).toBe('warming');

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

    const twoClean = run(oneClean.state, { type: 'predictionReceived', frameIndex: 2, unsafe: false, at: 1800 });
    expect(twoClean.effects).toContainEqual({ kind: 'clearVerdict' });
    expect(twoClean.effects).toContainEqual({ kind: 'setStatus', status: 'safe' });
    expect(twoClean.effects).toContainEqual({ kind: 'stopDvr' });
    expect(twoClean.state.dvr).toBe('off');

    // An unsafe sample resets the clean streak (and restarts the DVR path).
    const reMasked = run(twoClean.state, { type: 'predictionReceived', frameIndex: 3, unsafe: true, at: 2100 });
    expect(reMasked.effects).toContainEqual({ kind: 'startDvr' });
    const cleanAgain = run(reMasked.state, { type: 'predictionReceived', frameIndex: 4, unsafe: false, at: 2400 });
    expect(cleanAgain.effects).not.toContainEqual({ kind: 'clearVerdict' });
  });

  it('runs the DVR lifecycle: warm-up blur, bufferReady swap, pause hand-back, dispose teardown', () => {
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

    // Pause: static frame → DOM overlay path; the DVR stops.
    const paused = run(nextUnsafe.state, { type: 'pause', at: 4000 });
    expect(paused.state.phase).toBe('standby');
    expect(paused.state.dvr).toBe('off');
    expect(paused.effects).toContainEqual({ kind: 'stopDvr' });
    expect(paused.effects).toContainEqual({ kind: 'applyBlur' });
    expect(paused.effects).toContainEqual({ kind: 'applyVerdictThenClearBlur' });
    expect(paused.effects).not.toContainEqual({ kind: 'clearBlur' });

    // Dispose mid-presentation: stopDvr and cleanup exactly once.
    const disposed = run(nextUnsafe.state, { type: 'dispose' });
    expect(disposed.effects.filter(e => e.kind === 'stopDvr')).toHaveLength(1);
    expect(disposed.effects.filter(e => e.kind === 'cleanup')).toHaveLength(1);
    const afterDispose = run(disposed.state, { type: 'bufferReady', at: 5000 });
    expect(afterDispose.effects).toHaveLength(0);
  });

  it('keeps a presenting DVR latched across clean streaks, bounded by the idle teardown timer', () => {
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
    expect(clean.effects).not.toContainEqual({ kind: 'stopDvr' });
    // The mask clear arms the idle teardown: the expensive path is a tail, not forever.
    expect(clean.effects).toContainEqual({ kind: 'startTimer', timer: 'dvrIdle', ms: DVR_IDLE_TEARDOWN_MS });

    // An unsafe verdict within the idle window keeps the DVR: no blink, timer cancelled.
    const unsafeAgain = run(clean.state, {
      type: 'predictionReceived',
      frameIndex: 3,
      unsafe: true,
      at: 2100,
    });
    expect(unsafeAgain.state.dvr).toBe('presenting');
    expect(unsafeAgain.effects).not.toContainEqual({ kind: 'startDvr' });
    expect(unsafeAgain.effects).not.toContainEqual({ kind: 'applyBlur' });
    expect(unsafeAgain.effects).toContainEqual({ kind: 'cancelTimer', timer: 'dvrIdle' });
  });

  it('tears the DVR down when the clean-idle timer fires, returning to native playback', () => {
    const clean = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 },
      { type: 'bufferReady', at: 1300 },
      { type: 'predictionReceived', frameIndex: 1, unsafe: false, at: 1500 },
      { type: 'predictionReceived', frameIndex: 2, unsafe: false, at: 1800 },
    );
    expect(clean.state.dvr).toBe('presenting');

    const fired = run(clean.state, { type: 'timerFired', timer: 'dvrIdle', at: 6800 });
    expect(fired.state.dvr).toBe('off');
    expect(fired.effects).toContainEqual({ kind: 'stopDvr' });
    // The video is clean and unblurred: teardown adds no blur or overlay work.
    expect(fired.effects).not.toContainEqual({ kind: 'applyBlur' });

    // A stale fire after the DVR already moved on is a no-op.
    const staleFire = run(fired.state, { type: 'timerFired', timer: 'dvrIdle', at: 7000 });
    expect(staleFire.effects).toHaveLength(0);
  });

  it('ignores a dvrIdle fire while masked (unsafe re-arrived before an unsafe cancel landed)', () => {
    const remasked = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 },
      { type: 'bufferReady', at: 1300 },
    );
    expect(remasked.state.masked).toBe(true);

    const fired = run(remasked.state, { type: 'timerFired', timer: 'dvrIdle', at: 6300 });
    expect(fired.effects).toHaveLength(0);
    expect(fired.state.dvr).toBe('presenting');
  });

  it('re-arms the idle teardown when a re-warmed DVR presents an already-clean video', () => {
    // Presenting + mask cleared (idle timer pending), then a seek re-warms the
    // DVR. The old timer fires harmlessly during warm-up; without a fresh arm
    // at bufferReady the unmasked DVR would latch forever again.
    const cleanPresenting = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 },
      { type: 'bufferReady', at: 1300 },
      { type: 'predictionReceived', frameIndex: 1, unsafe: false, at: 1500 },
      { type: 'predictionReceived', frameIndex: 2, unsafe: false, at: 1800 },
    );

    const seeked = run(cleanPresenting.state, { type: 'seeked', at: 2500 });
    expect(seeked.state.dvr).toBe('warming');

    // Stale fire mid-warm-up: no-op.
    const midWarm = run(seeked.state, { type: 'timerFired', timer: 'dvrIdle', at: 6800 });
    expect(midWarm.effects).toHaveLength(0);

    const rePresenting = run(midWarm.state, { type: 'bufferReady', at: 7000 });
    expect(rePresenting.state.dvr).toBe('presenting');
    expect(rePresenting.effects).toContainEqual({ kind: 'startTimer', timer: 'dvrIdle', ms: DVR_IDLE_TEARDOWN_MS });
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
});
