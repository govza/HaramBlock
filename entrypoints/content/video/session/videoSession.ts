import type { VerdictForOptions } from '@/entrypoints/content/video/timeline/verdictInterpreter';

export const LIVE_MASKING_START_COVERAGE_SEC = 1.5;
export const LIVE_MASKING_STOP_COVERAGE_SEC = 5;

export type TapState = 'pending' | 'reachable' | 'unreachable';
export type SessionPhase = 'active' | 'skipped' | 'disposed';
export type SessionStatus = 'safe' | 'unsafe' | 'skipped';

export interface VideoSessionState {
  phase: SessionPhase;
  tap: TapState;
  pixelsTainted: boolean;
  visible: boolean;
  coverageAheadSec: number;
  liveMasking: boolean;
  pausedFrameSampled: boolean;
  blurred: boolean;
  verdictSeen: boolean;
  status: SessionStatus | null;
  unsafeSeen: boolean;
}

export interface VideoSessionOptions {
  unsafeSeen?: boolean;
}

export type SessionEvent =
  | { type: 'tapReachable' }
  | { type: 'tapUnreachable' }
  | { type: 'sourceChanged'; coverageAheadSec: number }
  | { type: 'play' }
  | { type: 'pause'; covered: boolean }
  | { type: 'seeked'; paused: boolean; covered: boolean; coverageAheadSec: number }
  | { type: 'loopRestarted' }
  | { type: 'progress'; coverageAheadSec: number }
  | { type: 'verdict'; sampleId: string }
  | { type: 'thumbnailVerdict'; unsafe: boolean }
  | { type: 'liveSample'; sampleId: string }
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
  | { kind: 'reopenTap' }
  | { kind: 'commitSample'; sampleId: string }
  | { kind: 'setStatus'; status: SessionStatus }
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
  pausedFrameSampled: false,
  blurred: true,
  verdictSeen: false,
  status: null,
  unsafeSeen: false,
};

export function createVideoSession(options: VideoSessionOptions = {}): ReduceResult {
  const state = { ...INITIAL_STATE, unsafeSeen: options.unsafeSeen ?? false };
  return withLiveMaskingSynced({ state, effects: [{ kind: 'applyBlur' }] });
}

export function verdictOptionsOf(state: VideoSessionState): VerdictForOptions {
  return { holdUntilConfirmedClean: state.liveMasking };
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
    case 'sourceChanged':
      return {
        state: { ...state, coverageAheadSec: event.coverageAheadSec, pausedFrameSampled: false },
        effects: [{ kind: 'reopenTap' }],
      };
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
    case 'liveSample':
      return firstVerdictSeen(state, [{ kind: 'commitSample', sampleId: event.sampleId }], false);
    case 'thumbnailVerdict':
      return firstVerdictSeen(state, [], event.unsafe);
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
  const unsafeSeen = state.unsafeSeen || presentedUnsafe;
  const status: SessionStatus = unsafeSeen ? 'unsafe' : 'safe';
  return {
    state: { ...state, verdictSeen: true, blurred: false, status, unsafeSeen },
    effects: [...effects, ...(state.blurred ? [{ kind: 'clearBlur' } as const] : []), { kind: 'setStatus', status }],
  };
}

function presented(state: VideoSessionState, unsafe: boolean, effects: SessionEffect[] = []): ReduceResult {
  if (!unsafe || !state.verdictSeen || state.status === 'unsafe') return { state, effects };
  return {
    state: { ...state, status: 'unsafe', unsafeSeen: true },
    effects: [...effects, { kind: 'setStatus', status: 'unsafe' }],
  };
}

function taintPixels(state: VideoSessionState): ReduceResult {
  const next = { ...state, pixelsTainted: true };
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
  const status: SessionStatus = state.unsafeSeen ? 'unsafe' : 'skipped';
  return {
    state: { ...state, phase: 'skipped', blurred: false, status, liveMasking: false },
    effects: [
      ...(state.liveMasking ? [{ kind: 'stopLiveMasking' } as const] : []),
      ...(state.blurred ? [{ kind: 'clearBlur' } as const] : []),
      ...(state.status === status ? [] : [{ kind: 'setStatus', status } as const]),
    ],
  };
}
