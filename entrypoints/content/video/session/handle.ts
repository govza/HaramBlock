/**
 * Per-session mutable state shared by the session modules
 * (docs/VIDEO_PROCESSING.md).
 *
 * The registry creates a SessionHandle at adoption; each module owns its own
 * slice of the fields: lifecycle (registry.ts), sampling (frameSampler.ts),
 * viewport suspension (viewportSuspension.ts), and presentation
 * (presentationAdapter.ts).
 */

import type { DvrRun } from '@/entrypoints/content/video/dvr/run';
import type { VerdictTimeline } from '@/entrypoints/content/video/dvr/verdictTimeline';
import type { PendingFrameSample } from '@/entrypoints/content/video/frameSample';
import type { SessionTimer, VideoSessionState } from '@/entrypoints/content/video/session/machine';
import type { IFramePrediction, IHostSettings } from '@/utils/types';

export interface SessionHandle {
  readonly sessionId: string;
  readonly video: HTMLVideoElement;
  /** Object-backed sources have no URL; retain their identity for source-change detection. */
  readonly srcObject: HTMLVideoElement['srcObject'];
  readonly src: string;
  hostSettings: IHostSettings;
  state: VideoSessionState;
  lastPrediction: IFramePrediction | null;
  /** Most recent unsafe prediction: what `applyVerdict` renders (suspension re-masks need it). */
  lastUnsafePrediction: IFramePrediction | null;
  timers: Map<SessionTimer, ReturnType<typeof setTimeout>>;
  stopTicker: (() => void) | null;
  removeListeners: () => void;
  /** Serializes async overlay work so verdicts render in dispatch order. */
  overlayChain: Promise<void>;
  /** The live DVR run (dvr/run.ts); null while the DVR is off. All run-local state lives inside it. */
  dvrRun: DvrRun | null;
  /** Session-lifetime verdict history: survives DVR stop/start, seeks, and loop restarts. */
  readonly timeline: VerdictTimeline;
  /** Session-lifetime floor under the derived delay, learned from stall raises:
   *  a store that proved it needs a larger D must not re-limp after every re-warm. */
  dvrStallFloorSec: number;
  /** A WebCodecs error happened once: this session stays on the raw ring for its lifetime. */
  dvrEncodedIneligible: boolean;
  /** Session-local Frame Samples awaiting verdicts; future caches must not persist routing identity. */
  pendingSamples: Map<number, PendingFrameSample>;
  /** Recent sample→verdict round-trips; sizes the adaptive DVR delay. */
  latenciesMs: number[];
  /** Offscreen sessions retain verdict state but produce no captures or DVR work. */
  suspended: boolean;
  /** Pending grace-period timer between leaving the margin and suspending. */
  suspendGrace: ReturnType<typeof setTimeout> | null;
  /** Bumped on suspend so a capture that was in flight across it never sends its stale frame. */
  captureEpoch: number;
  /** Thumbnail readiness/capture that occurred while suspended. */
  pendingThumbnailCapture: boolean;
  /** A playback sample was deflected while suspended; a paused resume must re-sample the displayed frame. */
  pendingResample: boolean;
  /** Whether any playback frame was ever sent — a cancel RPC is a no-op before that. */
  sentPlaybackFrame: boolean;
}
