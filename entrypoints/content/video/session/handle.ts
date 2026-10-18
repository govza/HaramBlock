import type { LiveSampler } from '@/entrypoints/content/video/live/liveSampler';
import type { MaskPresenter } from '@/entrypoints/content/video/presenter/maskPresenter';
import type { VideoSessionState } from '@/entrypoints/content/video/session/videoSession';
import type { LookaheadSession } from '@/entrypoints/content/video/tap/lookaheadClient';
import type { VerdictInterpreter } from '@/entrypoints/content/video/timeline/verdictInterpreter';
import type { VerdictEntry } from '@/entrypoints/content/video/timeline/verdictTimeline';
import type { InferredSample } from '@/utils/lookahead/ports';
import type { TapKind } from '@/utils/lookahead/protocol';
import type { UmbrellaSession } from '@/utils/telemetry/roundtrip';
import type { IHostSettings } from '@/utils/types';
import type { VideoIdentity } from '@/utils/videoIdentity';

/**
 * A Live Masking frame sent for inference and awaiting its result.
 */
export interface PendingLiveSample {
  timestampSec: number;
  sentAt: number;
}

/**
 * A new source of the session's video kept waiting for its identity to settle, which decides whether
 * it continues the session's media; `cancel` stops waiting.
 */
export interface SourceIdentityWait {
  url: string;
  cancel: () => void;
}

/**
 * Mutable runtime state of one VideoSession held by the registry: the pure reducer state plus
 * everything impure around it (presenter, Live Masking sampler, lookahead session, in-flight
 * inference, listeners and telemetry).
 */
export interface SessionHandle {
  readonly sessionId: string;
  readonly video: HTMLVideoElement;
  readonly srcObject: HTMLVideoElement['srcObject'];
  src: string;
  identity: VideoIdentity;
  readonly trace: UmbrellaSession;
  hostSettings: IHostSettings;
  state: VideoSessionState;
  readonly interpreter: VerdictInterpreter;
  readonly presenter: MaskPresenter;
  readonly live: LiveSampler;
  lookahead: LookaheadSession | null;
  mediaDurationSec: number | null;
  verifyMediaOnDuration: boolean;
  sourceIdentityWait: SourceIdentityWait | null;
  tap: TapKind | null;
  nextFrameIndex: number;
  readonly pendingLive: Map<number, PendingLiveSample>;
  readonly pendingLookahead: Map<number, (sample: InferredSample | null) => void>;
  readonly heldSamples: Map<string, VerdictEntry>;
  nextSampleId: number;
  removeListeners: () => void;
  suspended: boolean;
  suspendGrace: ReturnType<typeof setTimeout> | null;
  lastProgressAt: number;
  lastFrameAt: number | null;
  liveMaskingSince: number | null;
  liveMaskingMs: number;
}
