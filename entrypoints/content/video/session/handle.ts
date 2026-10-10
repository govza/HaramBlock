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

export interface PendingLiveSample {
  timestampSec: number;
  sentAt: number;
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly video: HTMLVideoElement;
  readonly srcObject: HTMLVideoElement['srcObject'];
  readonly src: string;
  readonly cacheKey: string;
  readonly trace: UmbrellaSession;
  hostSettings: IHostSettings;
  state: VideoSessionState;
  readonly interpreter: VerdictInterpreter;
  readonly presenter: MaskPresenter;
  readonly live: LiveSampler;
  lookahead: LookaheadSession | null;
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
