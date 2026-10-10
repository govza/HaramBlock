export const LIVE_MASKING_START_COVERAGE_SEC = 1.5;
export const LIVE_MASKING_STOP_COVERAGE_SEC = 5;

export type TapState = 'pending' | 'reachable' | 'unreachable';
export type SessionPhase = 'active' | 'skipped' | 'disposed';
export type SessionStatus = 'safe' | 'unsafe' | 'skipped';
export type LiveVerdict = 'clean' | 'tentative' | 'confident';
export type TransientResolution = 'suppressed' | 'confirmed';

export interface VideoSessionState {
  phase: SessionPhase;
  tap: TapState;
  pixelsTainted: boolean;
  visible: boolean;
  coverageAheadSec: number;
  liveMasking: boolean;
  heldTentative: string | null;
  pausedFrameSampled: boolean;
  blurred: boolean;
  verdictSeen: boolean;
  status: SessionStatus | null;
}

export type SessionEvent =
  | { type: 'tapReachable' }
  | { type: 'tapUnreachable' }
  | { type: 'play' }
  | { type: 'pause'; covered: boolean }
  | { type: 'seeked'; paused: boolean; covered: boolean; coverageAheadSec: number }
  | { type: 'loopRestarted' }
  | { type: 'progress'; coverageAheadSec: number }
  | { type: 'verdict'; sampleId: string }
  | { type: 'thumbnailVerdict'; unsafe: boolean }
  | { type: 'liveSample'; sampleId: string; verdict: LiveVerdict }
  | { type: 'liveCaptureFailed'; permanent: boolean }
  | { type: 'presented'; unsafe: boolean }
  | { type: 'visibility'; visible: boolean }
  | { type: 'dispose' };

export type SessionEffect =
  | { kind: 'applyBlur' }
  | { kind: 'clearBlur' }
  | { kind: 'startLiveMasking' }
  | { kind: 'stopLiveMasking' }
  | { kind: 'requestLiveSample' }
  | { kind: 'commitSample'; sampleId: string }
  | { kind: 'discardSample'; sampleId: string }
  | { kind: 'setStatus'; status: SessionStatus }
  | { kind: 'transientResolved'; resolution: TransientResolution }
  | { kind: 'cleanup' };

export interface ReduceResult {
  state: VideoSessionState;
  effects: SessionEffect[];
}

const INITIAL_STATE: VideoSessionState = {
  phase: 'active',
  tap: 'pending',
  pixelsTainted: false,
  visible: true,
  coverageAheadSec: 0,
  liveMasking: false,
  heldTentative: null,
  pausedFrameSampled: false,
  blurred: true,
  verdictSeen: false,
  status: null,
};

export function createVideoSession(): ReduceResult {
  return withLiveMaskingSynced({ state: INITIAL_STATE, effects: [{ kind: 'applyBlur' }] });
}

export function reduce(state: VideoSessionState, event: SessionEvent): ReduceResult {
  if (state.phase === 'disposed') return { state, effects: [] };
  if (event.type === 'dispose') {
    return {
      state: { ...state, phase: 'disposed', liveMasking: false },
      effects: [...(state.liveMasking ? [{ kind: 'stopLiveMasking' } as const] : []), { kind: 'cleanup' }],
    };
  }
  if (state.phase === 'skipped') return { state, effects: [] };
  return withLiveMaskingSynced(reduceActive(state, event));
}

function reduceActive(state: VideoSessionState, event: SessionEvent): ReduceResult {
  switch (event.type) {
    case 'tapReachable':
      return releaseTaintedCover({ state: { ...state, tap: 'reachable' }, effects: [] });
    case 'tapUnreachable':
      return state.pixelsTainted ? finalizeSkipped(state) : unchanged({ ...state, tap: 'unreachable' });
    case 'play':
      return unchanged({ ...state, pausedFrameSampled: false });
    case 'pause':
      return samplePausedFrame(state, event.covered);
    case 'seeked': {
      const next = { ...state, coverageAheadSec: event.coverageAheadSec, pausedFrameSampled: false };
      return event.paused ? samplePausedFrame(next, event.covered) : unchanged(next);
    }
    case 'loopRestarted':
      return unchanged(state);
    case 'progress':
      return unchanged({ ...state, coverageAheadSec: event.coverageAheadSec });
    case 'verdict':
      return firstVerdictSeen(state, [{ kind: 'commitSample', sampleId: event.sampleId }], false);
    case 'thumbnailVerdict':
      return firstVerdictSeen(state, [], event.unsafe);
    case 'liveSample':
      return liveSampleArrived(state, event.sampleId, event.verdict);
    case 'liveCaptureFailed':
      return event.permanent ? taintPixels(state) : unchanged(state);
    case 'presented':
      return presented(state, event.unsafe);
    case 'visibility':
      return unchanged({ ...state, visible: event.visible });
    case 'dispose':
      return unchanged(state);
  }
}

function unchanged(state: VideoSessionState): ReduceResult {
  return { state, effects: [] };
}

function wantsLiveMasking(state: VideoSessionState): boolean {
  if (state.phase !== 'active' || !state.visible || state.pixelsTainted) return false;
  if (state.tap !== 'reachable') return true;
  const threshold = state.liveMasking ? LIVE_MASKING_STOP_COVERAGE_SEC : LIVE_MASKING_START_COVERAGE_SEC;
  return state.coverageAheadSec < threshold;
}

function withLiveMaskingSynced(result: ReduceResult): ReduceResult {
  const wanted = wantsLiveMasking(result.state);
  if (wanted === result.state.liveMasking) return result;
  return {
    state: { ...result.state, liveMasking: wanted },
    effects: [...result.effects, { kind: wanted ? 'startLiveMasking' : 'stopLiveMasking' }],
  };
}

function samplePausedFrame(state: VideoSessionState, covered: boolean): ReduceResult {
  if (covered || state.pausedFrameSampled || state.pixelsTainted) return unchanged(state);
  return { state: { ...state, pausedFrameSampled: true }, effects: [{ kind: 'requestLiveSample' }] };
}

function firstVerdictSeen(state: VideoSessionState, effects: SessionEffect[], presentedUnsafe: boolean): ReduceResult {
  if (state.verdictSeen) return presentedUnsafe ? presented(state, true, effects) : { state, effects };
  const status: SessionStatus = presentedUnsafe ? 'unsafe' : 'safe';
  return {
    state: { ...state, verdictSeen: true, blurred: false, status },
    effects: [...effects, ...(state.blurred ? [{ kind: 'clearBlur' } as const] : []), { kind: 'setStatus', status }],
  };
}

function liveSampleArrived(state: VideoSessionState, sampleId: string, verdict: LiveVerdict): ReduceResult {
  const held = state.heldTentative;
  if (verdict === 'tentative' && held === null) {
    return { state: { ...state, heldTentative: sampleId }, effects: [{ kind: 'requestLiveSample' }] };
  }
  const effects: SessionEffect[] = [];
  if (held !== null && verdict === 'clean') {
    effects.push({ kind: 'discardSample', sampleId: held }, { kind: 'transientResolved', resolution: 'suppressed' });
  } else if (held !== null) {
    effects.push({ kind: 'commitSample', sampleId: held }, { kind: 'transientResolved', resolution: 'confirmed' });
  }
  effects.push({ kind: 'commitSample', sampleId });
  return firstVerdictSeen({ ...state, heldTentative: null }, effects, false);
}

function presented(state: VideoSessionState, unsafe: boolean, effects: SessionEffect[] = []): ReduceResult {
  const status: SessionStatus = unsafe ? 'unsafe' : 'safe';
  if (!state.verdictSeen || state.status === status) return { state, effects };
  return { state: { ...state, status }, effects: [...effects, { kind: 'setStatus', status }] };
}

function taintPixels(state: VideoSessionState): ReduceResult {
  const next = { ...state, pixelsTainted: true, heldTentative: null };
  if (state.tap === 'unreachable') return finalizeSkipped(next);
  if (state.tap === 'reachable') return releaseTaintedCover({ state: next, effects: [] });
  return unchanged(next);
}

function releaseTaintedCover(result: ReduceResult): ReduceResult {
  const { state } = result;
  if (!state.pixelsTainted || !state.blurred) return result;
  return { state: { ...state, blurred: false }, effects: [...result.effects, { kind: 'clearBlur' }] };
}

function finalizeSkipped(state: VideoSessionState): ReduceResult {
  return {
    state: { ...state, phase: 'skipped', blurred: false, status: 'skipped', liveMasking: false },
    effects: [
      ...(state.liveMasking ? [{ kind: 'stopLiveMasking' } as const] : []),
      ...(state.blurred ? [{ kind: 'clearBlur' } as const] : []),
      { kind: 'setStatus', status: 'skipped' },
    ],
  };
}
