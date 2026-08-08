/**
 * Pure VideoSession state machine (docs/VIDEO_PROCESSING.md). No DOM, no timers, no transport:
 * events carry timestamps in, effects describe what the adapter must do out.
 */

export type SessionPhase = 'adopted' | 'thumbnailing' | 'standby' | 'sampling' | 'error' | 'disposed';

/**
 * DVR presentation lifecycle: 'warming' = ring buffer filling behind the
 * whole-blur; 'presenting' = the delayed canvas has replaced native rendering.
 */
export type DvrMode = 'off' | 'warming' | 'presenting';

export interface VideoSessionState {
  phase: SessionPhase;
  /** Whether the Thumbnail send was already retried after a fail-closed timeout. */
  thumbnailRetried: boolean;
  /** Index of the Frame Sample awaiting its verdict; only one may be in flight. */
  inflightIndex: number | null;
  /** Timestamp of the last sample send, for the floor interval. */
  lastSentAt: number;
  /** Next Frame Sample index; monotonic within the session. */
  nextFrameIndex: number;
  /** Highest frameIndex whose verdict was applied; older predictions are Stale. */
  lastAppliedIndex: number;
  /** A verdict mask is currently applied. */
  masked: boolean;
  /** Consecutive clean samples while masked; clears the mask at the hysteresis threshold. */
  cleanStreak: number;
  /** The whole-video blur is active (adoption blur or watchdog re-blur). */
  blurred: boolean;
  /** Consecutive capture/send failures; ERROR at the limit. */
  errorStreak: number;
  /** A seek happened while a send was in flight (or during THUMBNAILING);
   *  the newly displayed frame must be sampled as soon as the slot frees. */
  pendingSeek: boolean;
  /** Media position belonging to the remembered seek's displayed frame. */
  pendingSeekTimestampSec: number | null;
  /** Delayed-presentation state; every playing processed video drives it (continuous DVR). */
  dvr: DvrMode;
}

export const THUMBNAIL_TIMEOUT_MS = 10_000;
export const SAMPLE_FLOOR_MS = 250;
export const CLEAN_STREAK_TO_CLEAR = 2;
export const WATCHDOG_MS = 5_000;
export const SAMPLE_TIMEOUT_MS = 3_000;
export const MAX_CONSECUTIVE_ERRORS = 10;
/** How long a transient-failure ERROR rests before sampling is retried. */
export const ERROR_RETRY_COOLDOWN_MS = 30_000;

export type SessionTimer = 'thumbnailTimeout' | 'watchdog' | 'sampleTimeout' | 'errorCooldown';

export type SessionStatus = 'safe' | 'unsafe' | 'skipped';

export type SessionEvent =
  | { type: 'thumbnailSourceReady' }
  | { type: 'sampleSent'; frameIndex: number; at: number }
  | { type: 'predictionReceived'; frameIndex: number; unsafe: boolean; at: number }
  | { type: 'timerFired'; timer: SessionTimer; at: number }
  | { type: 'play'; at: number }
  | { type: 'frameAvailable'; at: number; timestampSec: number }
  | { type: 'seeked'; at: number; timestampSec: number }
  | { type: 'pause'; at: number }
  | { type: 'ended'; at: number }
  /** The video left the viewport: release the DVR and hand masking back to the DOM. */
  | { type: 'suspend'; at: number }
  /** The attempt finalized without a verdict: capture/send failure, or the background
   *  replied with an inference error. permanent: capture can never succeed for this
   *  source (e.g. canvas taint), not a transient miss. */
  | { type: 'sendFailed'; frameIndex: number; at: number; permanent?: boolean }
  /** Capture was abandoned before transport (for example, the video left the viewport). */
  | { type: 'sampleCancelled'; frameIndex: number; at: number }
  /** The DVR ring buffer spans the presentation delay; the canvas has taken over. */
  | { type: 'bufferReady'; at: number }
  /** This element's audio can never ride the delay line (origin-tainted source
   *  at adoption, or the site captured the element — discovered at engage).
   *  Delayability is a precondition (ADR 0001): protection is withdrawn. */
  | { type: 'audioUndelayable'; at: number }
  | { type: 'dispose' };

export type SessionEffect =
  | { kind: 'applyBlur' }
  | { kind: 'clearBlur' }
  | { kind: 'captureThumbnail' }
  | { kind: 'applyVerdict' }
  /** Paint the static mask while protected, then lift the whole-video blur. */
  | { kind: 'applyVerdictThenClearBlur' }
  | { kind: 'clearVerdict' }
  | { kind: 'setStatus'; status: SessionStatus }
  | { kind: 'sendSample'; frameIndex: number; timestampSec: number }
  | { kind: 'startTimer'; timer: SessionTimer; ms: number }
  | { kind: 'cancelTimer'; timer: SessionTimer }
  | { kind: 'stopTicker' }
  /** Restart the frame ticker after an error cooldown (re-enter SAMPLING if playing). */
  | { kind: 'resumeTicker' }
  | { kind: 'startDvr' }
  | { kind: 'stopDvr' }
  /** Playback ended: keep consuming the ring in real time to the final frame, then hold it. */
  | { kind: 'drainDvr' }
  | { kind: 'cleanup' };

export interface ReduceResult {
  state: VideoSessionState;
  effects: SessionEffect[];
}

export function createVideoSession(): ReduceResult {
  return {
    state: {
      phase: 'adopted',
      thumbnailRetried: false,
      inflightIndex: null,
      lastSentAt: Number.NEGATIVE_INFINITY,
      nextFrameIndex: 0,
      lastAppliedIndex: Number.NEGATIVE_INFINITY,
      masked: false,
      cleanStreak: 0,
      blurred: true,
      errorStreak: 0,
      pendingSeek: false,
      pendingSeekTimestampSec: null,
      dvr: 'off',
    },
    effects: [{ kind: 'applyBlur' }],
  };
}

export function reduce(state: VideoSessionState, event: SessionEvent): ReduceResult {
  return consumePendingSeek(reduceCore(state, event), eventTime(event));
}

/**
 * A remembered seek fires as soon as the in-flight slot is free in an active
 * phase — regardless of which event freed it (verdict, timeout, failure, or
 * the Thumbnail finalizing). Centralized so no branch can forget it.
 */
function consumePendingSeek(result: ReduceResult, at: number): ReduceResult {
  const { state } = result;
  if (!state.pendingSeek || state.inflightIndex !== null) return result;
  if (state.phase !== 'standby' && state.phase !== 'sampling') return result;
  if (state.pendingSeekTimestampSec === null) return result;
  const sent = sendNextSample(
    { ...state, pendingSeek: false, pendingSeekTimestampSec: null },
    at,
    state.pendingSeekTimestampSec,
  );
  return { state: sent.state, effects: [...result.effects, ...sent.effects] };
}

function eventTime(event: SessionEvent): number {
  return 'at' in event ? event.at : 0;
}

/** No verdict has ever been applied: the session is fail-closed pending its first. */
function verdictPending(state: VideoSessionState): boolean {
  return state.lastAppliedIndex === Number.NEGATIVE_INFINITY;
}

function reduceCore(state: VideoSessionState, event: SessionEvent): ReduceResult {
  if (state.phase === 'disposed') {
    return { state, effects: [] };
  }
  if (event.type === 'dispose') {
    return {
      state: {
        ...state,
        phase: 'disposed',
        inflightIndex: null,
        pendingSeek: false,
        pendingSeekTimestampSec: null,
        dvr: 'off',
      },
      effects: state.dvr === 'off' ? [{ kind: 'cleanup' }] : [{ kind: 'stopDvr' }, { kind: 'cleanup' }],
    };
  }
  if (event.type === 'audioUndelayable') {
    // Undelayable audio finalizes `skipped` from any live phase — permanently
    // desynced audio was judged worse than absent protection. ERROR is already
    // terminal; re-finalizing there would re-run teardown effects.
    return state.phase === 'error' ? { state, effects: [] } : finalizeAllow(state, { terminal: true });
  }
  if (event.type === 'thumbnailSourceReady' && state.phase === 'adopted') {
    return { state: { ...state, phase: 'thumbnailing' }, effects: [{ kind: 'captureThumbnail' }] };
  }
  if (
    event.type === 'thumbnailSourceReady' &&
    (state.phase === 'sampling' || state.phase === 'standby') &&
    verdictPending(state)
  ) {
    // Play preempted THUMBNAILING before readiness. The session is active but
    // verdict-less (still blurred); the Thumbnail is just sample #-1, so the
    // ordering rule keeps this race-free.
    return { state, effects: [{ kind: 'captureThumbnail' }] };
  }
  if (event.type === 'sampleSent' && event.frameIndex === -1) {
    return { state, effects: [{ kind: 'startTimer', timer: 'thumbnailTimeout', ms: THUMBNAIL_TIMEOUT_MS }] };
  }
  if (event.type === 'sampleSent') {
    return { state, effects: [{ kind: 'startTimer', timer: 'sampleTimeout', ms: SAMPLE_TIMEOUT_MS }] };
  }
  if (event.type === 'timerFired' && event.timer === 'sampleTimeout') {
    // The in-flight verdict is lost; free the slot so sampling never stalls.
    return { state: { ...state, inflightIndex: null }, effects: [] };
  }
  if (event.type === 'sampleCancelled') {
    const inflightIndex = event.frameIndex === state.inflightIndex ? null : state.inflightIndex;
    return {
      state: { ...state, inflightIndex },
      effects:
        inflightIndex === null && state.inflightIndex !== null ? [{ kind: 'cancelTimer', timer: 'sampleTimeout' }] : [],
    };
  }
  if (event.type === 'predictionReceived' && state.phase === 'thumbnailing') {
    if (state.pendingSeek) {
      // The verdict describes a frame that is no longer displayed: keep the
      // blur (fail-closed); the pending post-seek sample decides what shows.
      return {
        state: { ...state, phase: 'standby', lastAppliedIndex: event.frameIndex, masked: event.unsafe },
        effects: [
          { kind: 'cancelTimer', timer: 'thumbnailTimeout' },
          ...(event.unsafe
            ? [{ kind: 'applyVerdict' } as const, { kind: 'setStatus', status: 'unsafe' } as const]
            : []),
        ],
      };
    }
    return {
      state: { ...state, phase: 'standby', lastAppliedIndex: event.frameIndex, masked: event.unsafe, blurred: false },
      effects: [
        { kind: 'cancelTimer', timer: 'thumbnailTimeout' },
        ...(event.unsafe
          ? ([{ kind: 'applyBlur' }, { kind: 'applyVerdictThenClearBlur' }] as const)
          : ([{ kind: 'clearVerdict' }, { kind: 'clearBlur' }] as const)),
        { kind: 'setStatus', status: event.unsafe ? 'unsafe' : 'safe' },
      ],
    };
  }
  if (event.type === 'predictionReceived' && (state.phase === 'sampling' || state.phase === 'standby')) {
    const inflightIndex = event.frameIndex === state.inflightIndex ? null : state.inflightIndex;
    if (event.frameIndex <= state.lastAppliedIndex) {
      // Stale Prediction: an older sample must never override a newer verdict.
      return { state: { ...state, inflightIndex }, effects: [] };
    }

    // Verdicts are flowing: rewind the watchdog (sampling only) and lift any active blur.
    const effects: SessionEffect[] =
      state.phase === 'sampling' ? [{ kind: 'startTimer', timer: 'watchdog', ms: WATCHDOG_MS }] : [];
    if (inflightIndex === null && state.inflightIndex !== null) {
      // The in-flight sample resolved: its timeout must not fire under a later sample.
      effects.push({ kind: 'cancelTimer', timer: 'sampleTimeout' });
    }
    const next = { ...state, inflightIndex, lastAppliedIndex: event.frameIndex, blurred: false, errorStreak: 0 };

    if (event.unsafe) {
      // Instant on: an unsafe sample masks immediately and resets the clean streak.
      next.masked = true;
      next.cleanStreak = 0;
      if (state.phase === 'sampling') {
        // Playback masking is the DVR's job: a DOM overlay would chase content
        // that has already moved on. Whole-blur covers until the canvas warms.
        if (state.dvr === 'off') {
          next.dvr = 'warming';
          next.blurred = true;
          effects.push({ kind: 'applyBlur' }, { kind: 'startDvr' });
        } else if (state.dvr === 'warming') {
          // A safe session warms up unblurred; an unsafe verdict must cover it
          // now — the canvas is not presenting yet.
          next.blurred = true;
          if (!state.blurred) {
            effects.push({ kind: 'applyBlur' });
          }
        }
        // presenting: the player composites masks itself; no DOM effects.
      } else if (state.dvr === 'off') {
        // Paused (standby) verdict describes a static frame: precise DOM overlay.
        // Cover immediately while the async overlay loads/paints, then reveal it.
        effects.push({ kind: 'applyBlur' }, { kind: 'applyVerdictThenClearBlur' });
      } else if (state.dvr === 'warming') {
        // Paused mid-warm-up: the canvas is not presenting yet, so the
        // whole-blur is the cover; a DOM overlay would fight the DVR's element.
        next.blurred = true;
        if (!state.blurred) {
          effects.push({ kind: 'applyBlur' });
        }
      }
      // Paused while presenting: the canvas owns masking even for the frozen
      // frame; the verdict composites there with no DOM effects.
      effects.push({ kind: 'setStatus', status: 'unsafe' });
    } else {
      next.cleanStreak = state.masked ? state.cleanStreak + 1 : 0;
      if (state.masked && next.cleanStreak >= CLEAN_STREAK_TO_CLEAR) {
        // Slow off: only a sustained clean run may clear the mask.
        next.masked = false;
        next.cleanStreak = 0;
        // The DVR stays untouched: it is the permanent presentation for the
        // rest of playback (continuous DVR). For a warming session this
        // clearBlur is also the un-blur escape when the buffer never becomes
        // ready (capture failure) — bufferReady can never lift the blur there.
        effects.push({ kind: 'clearVerdict' }, { kind: 'clearBlur' }, { kind: 'setStatus', status: 'safe' });
      } else if (state.masked && state.dvr === 'warming') {
        // Clean sample short of the streak: the warm-up blur is the only
        // protection (no DOM overlay on this path) — keep it until bufferReady.
        next.blurred = true;
      } else if (state.blurred || verdictPending(state)) {
        // verdictPending: the first verdict must land a status even when
        // bufferReady already lifted the blur (it beats the inference
        // round-trip on the common continuous-DVR path).
        if (state.blurred) {
          effects.push({ kind: 'clearBlur' });
        }
        if (!next.masked) {
          effects.push({ kind: 'setStatus', status: 'safe' });
        }
      }
    }
    return { state: next, effects };
  }
  if (event.type === 'bufferReady' && state.dvr === 'warming') {
    // The delayed canvas is drawing (masked, synced): swap out the whole-blur
    // and any leftover DOM overlay from a pre-playback verdict.
    return {
      state: { ...state, dvr: 'presenting', blurred: false },
      effects: [{ kind: 'clearVerdict' }, { kind: 'clearBlur' }],
    };
  }
  if (
    event.type === 'play' &&
    (state.phase === 'standby' || state.phase === 'thumbnailing' || state.phase === 'adopted')
  ) {
    const effects: SessionEffect[] = [{ kind: 'startTimer', timer: 'watchdog', ms: WATCHDOG_MS }];
    const next = { ...state, phase: 'sampling' as const };
    if (state.dvr === 'off') {
      // Continuous DVR: every playing video presents delayed, so a later
      // unsafe verdict composites in without a visible mode switch. Cover the
      // warm-up only when fail-closed demands it: whole-blur for a masked
      // session (its static DOM overlay would lag the moving content); the
      // adoption blur is simply retained for a verdict-less one. A
      // safe-verdicted session warms up unblurred behind its pinned frame.
      next.dvr = 'warming';
      if (state.masked) {
        next.blurred = true;
        effects.push({ kind: 'applyBlur' });
      }
      effects.push({ kind: 'startDvr' });
    }
    return { state: next, effects };
  }
  if (event.type === 'sendFailed' && state.phase === 'thumbnailing') {
    if (event.permanent) {
      // Capture can never succeed (e.g. canvas taint): inference-impossible is
      // not unsafe. Finalize as allow instead of blurring forever.
      return finalizeAllow(state, { terminal: true });
    }
    // Transient Thumbnail failure: stay fail-closed (blur kept), but leave the
    // session in STANDBY so playback sampling can still deliver a verdict. The
    // attempt is finalized, so a status must land — same stance as the timeout.
    return {
      state: { ...state, phase: 'standby', errorStreak: state.errorStreak + 1 },
      effects: [
        { kind: 'cancelTimer', timer: 'thumbnailTimeout' },
        { kind: 'setStatus', status: 'unsafe' },
      ],
    };
  }
  if (event.type === 'sendFailed' && (state.phase === 'sampling' || state.phase === 'standby')) {
    if (event.permanent) {
      return finalizeAllow(state, { terminal: true });
    }
    const errorStreak = state.errorStreak + 1;
    // Only the failure of the in-flight sample frees its slot.
    const inflightIndex = event.frameIndex === state.inflightIndex ? null : state.inflightIndex;
    if (errorStreak >= MAX_CONSECUTIVE_ERRORS) {
      // An unbroken transient streak is an outage, not an impossibility: rest,
      // then retry — the cooldown timer re-arms sampling.
      return finalizeAllow({ ...state, errorStreak }, { terminal: false });
    }
    return {
      state: { ...state, inflightIndex, errorStreak },
      effects:
        inflightIndex === null && state.inflightIndex !== null ? [{ kind: 'cancelTimer', timer: 'sampleTimeout' }] : [],
    };
  }
  if (event.type === 'suspend' && (state.phase === 'sampling' || state.phase === 'standby')) {
    // The one DVR exit playback state cannot see coming: offscreen sessions
    // must return their ring memory. A paused frame is static again, so the
    // precise DOM overlay takes over before the native element is revealed.
    const effects: SessionEffect[] = [{ kind: 'cancelTimer', timer: 'watchdog' }];
    const next = { ...state, phase: 'standby' as const };
    if (state.dvr !== 'off') {
      next.dvr = 'off';
      if (state.masked) {
        next.blurred = false;
        // The native element becomes visible when the DVR stops. Blur it first,
        // and only lift that protection after the static overlay has painted.
        effects.push({ kind: 'applyBlur' }, { kind: 'applyVerdictThenClearBlur' });
      }
      effects.push({ kind: 'stopDvr' });
    }
    return { state: next, effects };
  }
  if (event.type === 'pause' && state.phase === 'sampling') {
    // Pause never exits the DVR: the media clock freezes, so the canvas holds
    // the delayed frame the viewer was actually seeing. Only the sampling
    // bookkeeping winds down; play resumes presentation without a re-warm.
    return { state: { ...state, phase: 'standby' }, effects: [{ kind: 'cancelTimer', timer: 'watchdog' }] };
  }
  if (event.type === 'ended' && (state.phase === 'sampling' || state.phase === 'standby')) {
    // Standby too: Chrome fires 'pause' just before 'ended' at the natural
    // end, so the drain request usually arrives after the pause freeze.
    const effects: SessionEffect[] = [{ kind: 'cancelTimer', timer: 'watchdog' }];
    const next = { ...state, phase: 'standby' as const };
    if (state.dvr === 'presenting') {
      // The ending must play out, not cut off: the presenter keeps consuming
      // the buffered tail in real time, then holds the final frame.
      effects.push({ kind: 'drainDvr' });
    } else if (state.dvr === 'warming') {
      // The canvas never took over (capture failure, sub-frame video): there
      // is no tail to drain and bufferReady can never fire after ended, so a
      // kept warm-up blur would latch forever. Hand back to the DOM overlay.
      next.dvr = 'off';
      if (state.masked) {
        next.blurred = false;
        effects.push({ kind: 'applyBlur' }, { kind: 'applyVerdictThenClearBlur' });
      }
      effects.push({ kind: 'stopDvr' });
    }
    return { state: next, effects };
  }
  if (event.type === 'frameAvailable' && state.phase === 'sampling') {
    if (state.inflightIndex !== null || event.at - state.lastSentAt < SAMPLE_FLOOR_MS) {
      return { state, effects: [] };
    }
    return sendNextSample(state, event.at, event.timestampSec);
  }
  if (
    event.type === 'seeked' &&
    (state.phase === 'sampling' || state.phase === 'standby' || state.phase === 'thumbnailing')
  ) {
    // The displayed frame changed: sample it now, floor interval waived. If a
    // send is already in flight (or the Thumbnail round-trip is), remember the
    // seek and fire once the slot frees.
    const sampled =
      state.phase === 'thumbnailing' || state.inflightIndex !== null
        ? {
            state: { ...state, pendingSeek: true, pendingSeekTimestampSec: event.timestampSec },
            effects: [] as SessionEffect[],
          }
        : sendNextSample(state, event.at, event.timestampSec);
    if (state.dvr === 'off') return sampled;
    // Ring-buffer discontinuity: the buffered frames no longer precede the new
    // position. Flush by re-warming, re-establishing whatever fail-closed
    // cover the torn-down canvas was providing: whole-blur while masked, or
    // when a verdict-less presentation loses its per-frame canvas cover. A
    // safe session re-warms behind its pinned frame; a verdict-less warm-up
    // keeps whatever blur it already had (a resumed skipped session stays
    // deliberately unblurred, an adoption-blurred one stays covered).
    const coverWarmUp = state.masked || (verdictPending(state) && state.dvr === 'presenting');
    return {
      state: { ...sampled.state, dvr: 'warming', blurred: coverWarmUp || sampled.state.blurred },
      effects: [
        ...(coverWarmUp ? [{ kind: 'applyBlur' } as const] : []),
        { kind: 'stopDvr' },
        { kind: 'startDvr' },
        ...sampled.effects,
      ],
    };
  }
  if (event.type === 'timerFired' && event.timer === 'watchdog' && state.phase === 'sampling') {
    if (state.dvr === 'presenting') {
      // The DVR already fails closed per frame (verdict-late frames present
      // whole-blurred); re-blurring the hidden native element does nothing.
      return { state, effects: [] };
    }
    // Fail-closed: verdict silence mid-playback hides the video until inference recovers.
    return { state: { ...state, blurred: true }, effects: [{ kind: 'applyBlur' }] };
  }
  if (event.type === 'timerFired' && event.timer === 'errorCooldown' && state.phase === 'error') {
    // The outage may be over: back to STANDBY with a clean slate. The adapter
    // restarts the ticker and re-enters SAMPLING if the video is playing; the
    // session stays allowed (status skipped) until a fresh verdict lands.
    return {
      state: { ...state, phase: 'standby', errorStreak: 0 },
      effects: [{ kind: 'resumeTicker' }],
    };
  }
  if (event.type === 'timerFired' && event.timer === 'thumbnailTimeout' && state.phase === 'thumbnailing') {
    if (!state.thumbnailRetried) {
      return { state: { ...state, thumbnailRetried: true }, effects: [{ kind: 'captureThumbnail' }] };
    }
    // Fail-closed: no verdict after retry — blur stays; STANDBY keeps the session exit-able.
    return {
      state: { ...state, phase: 'standby' },
      effects: [{ kind: 'setStatus', status: 'unsafe' }],
    };
  }
  return { state, effects: [] };
}

/**
 * ERROR = allow, not block: the pipeline cannot analyze this video right now,
 * and inference-impossible is not evidence of unsafe content. The video plays
 * natively un-blurred, finalized as `skipped`; sampling and the ticker stop.
 * Fail-closed blur applies only while a verdict is genuinely pending.
 *
 * A permanent capture failure (canvas taint) is terminal. A transient failure
 * streak is an OUTAGE, not an impossibility — a busy inference backend or a
 * suspended event page recovers — so it rests for ERROR_RETRY_COOLDOWN_MS and
 * then resumes sampling; protection must not stay dead for the tab's lifetime.
 */
function finalizeAllow(state: VideoSessionState, opts: { terminal: boolean }): ReduceResult {
  return {
    state: {
      ...state,
      phase: 'error',
      inflightIndex: null,
      masked: false,
      cleanStreak: 0,
      blurred: false,
      pendingSeek: false,
      pendingSeekTimestampSec: null,
      dvr: 'off',
    },
    effects: [
      ...(state.dvr === 'off' ? [] : [{ kind: 'stopDvr' } as const]),
      { kind: 'clearVerdict' },
      { kind: 'clearBlur' },
      { kind: 'setStatus', status: 'skipped' },
      { kind: 'stopTicker' },
      { kind: 'cancelTimer', timer: 'thumbnailTimeout' },
      { kind: 'cancelTimer', timer: 'watchdog' },
      { kind: 'cancelTimer', timer: 'sampleTimeout' },
      ...(opts.terminal ? [] : [{ kind: 'startTimer', timer: 'errorCooldown', ms: ERROR_RETRY_COOLDOWN_MS } as const]),
    ],
  };
}

function sendNextSample(state: VideoSessionState, at: number, timestampSec: number): ReduceResult {
  return {
    state: { ...state, inflightIndex: state.nextFrameIndex, lastSentAt: at, nextFrameIndex: state.nextFrameIndex + 1 },
    effects: [{ kind: 'sendSample', frameIndex: state.nextFrameIndex, timestampSec }],
  };
}
