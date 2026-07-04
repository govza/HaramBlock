import { describe, expect, it } from 'vitest';

import {
  createVideoSession,
  MAX_CONSECUTIVE_ERRORS,
  reduce,
  SAMPLE_TIMEOUT_MS,
  THUMBNAIL_TIMEOUT_MS,
  WATCHDOG_MS,
  type SessionEvent,
  type VideoSessionState,
} from '@/entrypoints/content/video/session/machine';

/** Run a sequence of events through the reducer, returning the final state and all effects. */
function run(state: VideoSessionState, ...events: SessionEvent[]) {
  let current = state;
  const effects = [];
  for (const event of events) {
    const result = reduce(current, event);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

describe('VideoSession machine', () => {
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
    expect(effects).toContainEqual({ kind: 'applyVerdict' });
    expect(effects).toContainEqual({ kind: 'clearBlur' });
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

  it('applies unsafe samples instantly and drops Stale Predictions', () => {
    const sampling = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sampleSent', frameIndex: -1, at: 0 },
      { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 100 },
      { type: 'play', at: 1000 },
      { type: 'frameAvailable', at: 1010 },
      { type: 'sampleSent', frameIndex: 0, at: 1015 },
    );

    const unsafe = run(sampling.state, { type: 'predictionReceived', frameIndex: 0, unsafe: true, at: 1200 });
    expect(unsafe.effects).toContainEqual({ kind: 'applyVerdict' });
    expect(unsafe.effects).toContainEqual({ kind: 'setStatus', status: 'unsafe' });

    // A late redelivery of the Thumbnail verdict (frame -1) is a Stale Prediction:
    // it must not clear the mask the newer unsafe sample just applied.
    const stale = run(unsafe.state, { type: 'predictionReceived', frameIndex: -1, unsafe: false, at: 1250 });
    expect(stale.effects).toHaveLength(0);
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

    const twoClean = run(oneClean.state, { type: 'predictionReceived', frameIndex: 2, unsafe: false, at: 1800 });
    expect(twoClean.effects).toContainEqual({ kind: 'clearVerdict' });
    expect(twoClean.effects).toContainEqual({ kind: 'setStatus', status: 'safe' });

    // An unsafe sample resets the clean streak.
    const reMasked = run(twoClean.state, { type: 'predictionReceived', frameIndex: 3, unsafe: true, at: 2100 });
    expect(reMasked.effects).toContainEqual({ kind: 'applyVerdict' });
    const cleanAgain = run(reMasked.state, { type: 'predictionReceived', frameIndex: 4, unsafe: false, at: 2400 });
    expect(cleanAgain.effects).not.toContainEqual({ kind: 'clearVerdict' });
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
    expect(verdict.effects).toContainEqual({ kind: 'applyVerdict' });

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

  it('fails closed into ERROR after consecutive send failures; success resets the streak', () => {
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

    // An unbroken run of failures gives up fail-closed.
    let failing = sampling.state;
    let lastEffects;
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
      const result = run(failing, { type: 'sendFailed', frameIndex: 0, at: 5000 + i });
      failing = result.state;
      lastEffects = result.effects;
    }
    expect(failing.phase).toBe('error');
    expect(lastEffects).toContainEqual({ kind: 'applyBlur' });
    expect(lastEffects).toContainEqual({ kind: 'setStatus', status: 'error' });
    expect(lastEffects).toContainEqual({ kind: 'cancelTimer', timer: 'watchdog' });

    // Dead loop: presented frames no longer trigger sends.
    const afterError = run(failing, { type: 'frameAvailable', at: 9000 });
    expect(afterError.effects).toHaveLength(0);
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

  it('falls back to STANDBY fail-closed when the Thumbnail cannot be captured, still playable', () => {
    const failed = run(
      createVideoSession().state,
      { type: 'thumbnailSourceReady' },
      { type: 'sendFailed', frameIndex: -1, at: 100 }, // capture impossible (CORS-tainted / zero dimensions)
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
