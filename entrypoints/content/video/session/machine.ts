/**
 * Pure VideoSession state machine (ADR 0001). No DOM, no timers, no transport:
 * events carry timestamps in, effects describe what the adapter must do out.
 */

export type SessionPhase = 'adopted' | 'thumbnailing' | 'standby' | 'sampling' | 'error' | 'disposed';

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
}

export const THUMBNAIL_TIMEOUT_MS = 10_000;
export const SAMPLE_FLOOR_MS = 250;
export const CLEAN_STREAK_TO_CLEAR = 2;
export const WATCHDOG_MS = 5_000;
export const SAMPLE_TIMEOUT_MS = 3_000;
export const MAX_CONSECUTIVE_ERRORS = 10;

export type SessionTimer = 'thumbnailTimeout' | 'watchdog' | 'sampleTimeout';

export type SessionStatus = 'safe' | 'unsafe' | 'skipped' | 'error';

export type SessionEvent =
  | { type: 'thumbnailSourceReady' }
  | { type: 'sampleSent'; frameIndex: number; at: number }
  | { type: 'predictionReceived'; frameIndex: number; unsafe: boolean; at: number }
  | { type: 'timerFired'; timer: SessionTimer; at: number }
  | { type: 'play'; at: number }
  | { type: 'frameAvailable'; at: number }
  | { type: 'seeked'; at: number }
  | { type: 'pause'; at: number }
  | { type: 'ended'; at: number }
  | { type: 'sendFailed'; frameIndex: number; at: number }
  | { type: 'dispose' };

export type SessionEffect =
  | { kind: 'applyBlur' }
  | { kind: 'clearBlur' }
  | { kind: 'captureThumbnail' }
  | { kind: 'applyVerdict' }
  | { kind: 'clearVerdict' }
  | { kind: 'setStatus'; status: SessionStatus }
  | { kind: 'sendSample'; frameIndex: number }
  | { kind: 'startTimer'; timer: SessionTimer; ms: number }
  | { kind: 'cancelTimer'; timer: SessionTimer }
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
  const sent = sendNextSample({ ...state, pendingSeek: false }, at);
  return { state: sent.state, effects: [...result.effects, ...sent.effects] };
}

function eventTime(event: SessionEvent): number {
  return 'at' in event ? event.at : 0;
}

function reduceCore(state: VideoSessionState, event: SessionEvent): ReduceResult {
  if (state.phase === 'disposed') {
    return { state, effects: [] };
  }
  if (event.type === 'dispose') {
    return { state: { ...state, phase: 'disposed', inflightIndex: null }, effects: [{ kind: 'cleanup' }] };
  }
  if (event.type === 'thumbnailSourceReady' && state.phase === 'adopted') {
    return { state: { ...state, phase: 'thumbnailing' }, effects: [{ kind: 'captureThumbnail' }] };
  }
  if (
    event.type === 'thumbnailSourceReady' &&
    (state.phase === 'sampling' || state.phase === 'standby') &&
    state.lastAppliedIndex === Number.NEGATIVE_INFINITY
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
        event.unsafe ? { kind: 'applyVerdict' } : { kind: 'clearVerdict' },
        { kind: 'clearBlur' },
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
      effects.push({ kind: 'applyVerdict' }, { kind: 'clearBlur' }, { kind: 'setStatus', status: 'unsafe' });
    } else {
      next.cleanStreak = state.masked ? state.cleanStreak + 1 : 0;
      if (state.masked && next.cleanStreak >= CLEAN_STREAK_TO_CLEAR) {
        // Slow off: only a sustained clean run may clear the mask.
        next.masked = false;
        next.cleanStreak = 0;
        effects.push({ kind: 'clearVerdict' }, { kind: 'clearBlur' }, { kind: 'setStatus', status: 'safe' });
      } else if (state.blurred) {
        effects.push({ kind: 'clearBlur' });
        if (!next.masked) {
          effects.push({ kind: 'setStatus', status: 'safe' });
        }
      }
    }
    return { state: next, effects };
  }
  if (
    event.type === 'play' &&
    (state.phase === 'standby' || state.phase === 'thumbnailing' || state.phase === 'adopted')
  ) {
    return {
      state: { ...state, phase: 'sampling' },
      effects: [{ kind: 'startTimer', timer: 'watchdog', ms: WATCHDOG_MS }],
    };
  }
  if (event.type === 'sendFailed' && state.phase === 'thumbnailing') {
    // Thumbnail capture impossible: stay fail-closed (blur kept), but leave the
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
    const errorStreak = state.errorStreak + 1;
    // Only the failure of the in-flight sample frees its slot.
    const inflightIndex = event.frameIndex === state.inflightIndex ? null : state.inflightIndex;
    if (errorStreak >= MAX_CONSECUTIVE_ERRORS) {
      // Fail-closed: give up on this session but leave the video hidden, not exposed.
      return {
        state: { ...state, phase: 'error', inflightIndex: null, errorStreak },
        effects: [
          { kind: 'applyBlur' },
          { kind: 'setStatus', status: 'error' },
          { kind: 'cancelTimer', timer: 'watchdog' },
        ],
      };
    }
    return {
      state: { ...state, inflightIndex, errorStreak },
      effects:
        inflightIndex === null && state.inflightIndex !== null ? [{ kind: 'cancelTimer', timer: 'sampleTimeout' }] : [],
    };
  }
  if ((event.type === 'pause' || event.type === 'ended') && state.phase === 'sampling') {
    return {
      state: { ...state, phase: 'standby' },
      effects: [{ kind: 'cancelTimer', timer: 'watchdog' }],
    };
  }
  if (event.type === 'frameAvailable' && state.phase === 'sampling') {
    if (state.inflightIndex !== null || event.at - state.lastSentAt < SAMPLE_FLOOR_MS) {
      return { state, effects: [] };
    }
    return sendNextSample(state, event.at);
  }
  if (
    event.type === 'seeked' &&
    (state.phase === 'sampling' || state.phase === 'standby' || state.phase === 'thumbnailing')
  ) {
    // The displayed frame changed: sample it now, floor interval waived. If a
    // send is already in flight (or the Thumbnail round-trip is), remember the
    // seek and fire once the slot frees.
    if (state.phase === 'thumbnailing' || state.inflightIndex !== null) {
      return { state: { ...state, pendingSeek: true }, effects: [] };
    }
    return sendNextSample(state, event.at);
  }
  if (event.type === 'timerFired' && event.timer === 'watchdog' && state.phase === 'sampling') {
    // Fail-closed: verdict silence mid-playback hides the video until inference recovers.
    return { state: { ...state, blurred: true }, effects: [{ kind: 'applyBlur' }] };
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

function sendNextSample(state: VideoSessionState, at: number): ReduceResult {
  return {
    state: { ...state, inflightIndex: state.nextFrameIndex, lastSentAt: at, nextFrameIndex: state.nextFrameIndex + 1 },
    effects: [{ kind: 'sendSample', frameIndex: state.nextFrameIndex }],
  };
}
