/**
 * Per-session mutable state shared by the session modules
 * (docs/VIDEO_PROCESSING.md).
 *
 * The registry creates a SessionHandle at adoption; each module owns its own
 * slice of the fields: lifecycle (registry.ts), sampling (frameSampler.ts),
 * viewport suspension (viewportSuspension.ts), and presentation
 * (presentationAdapter.ts).
 */

import type { VideoDvrPlayer } from '@/entrypoints/content/presentation/videoDvrPlayer';
import type { SessionFrameStore } from '@/entrypoints/content/video/dvr/frameStoreFactory';
import type { VerdictTimeline } from '@/entrypoints/content/video/dvr/verdictTimeline';
import type { PendingFrameSample } from '@/entrypoints/content/video/frameSample';
import type { SessionTimer, VideoSessionState } from '@/entrypoints/content/video/session/machine';
import type { IFramePrediction, IHostSettings } from '@/utils/types';

interface DvrRuntime {
  store: SessionFrameStore;
  player: VideoDvrPlayer;
  /** Throttles buffer captures below the tick rate (rVFC ticks are denser). */
  lastCapturedMediaTime: number;
  /** Reused capture surface: transferToImageBitmap leaves the canvas reusable, so one per DVR run suffices. */
  captureSurface: OffscreenCanvas | null;
  /** Frame geometry the ring budget was last told about; 0 until metadata lands. */
  registeredWidth: number;
  registeredHeight: number;
  /** Display-derived capture-width cap last registered; re-registers on a material resize. */
  registeredCaptureCap: number;
  /** Store's covered-miss counter at the last per-verdict sync; a diff is a decode stall. */
  lastCoveredMisses: number;
  /** Consecutive underrun observations this run; dispatches analysisUnderrun at the hysteresis threshold. */
  underrunStreak: number;
}

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
  dvr: DvrRuntime | null;
  /** Session-lifetime verdict history: survives DVR stop/start, seeks, and loop restarts. */
  readonly timeline: VerdictTimeline;
  /** Presentation delay latched for the current DVR run; null while the DVR is off. */
  dvrDelaySec: number | null;
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
