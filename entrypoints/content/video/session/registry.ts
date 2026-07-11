/**
 * VideoSession registry and DOM adapter (docs/VIDEO_PROCESSING.md).
 *
 * The registry owns every live VideoSession (element × resolved source), routes
 * frame predictions by sessionId (no DOM queries), and executes the pure
 * machine's effects against the real world: blur classes, mask overlays,
 * capture + transport, and timers.
 */

import { cancelVideoSessionInference, requestVideoFrameInference } from '@/entrypoints/content/communication/sender';
import { BLUR_CLASS } from '@/entrypoints/content/presentation/constants';
import {
  clearProcessedStatus,
  PROCESSED_ATTR_MAP,
  type ProcessedStatus,
} from '@/entrypoints/content/presentation/initialStyling';
import { VideoDvrPlayer } from '@/entrypoints/content/presentation/videoDvrPlayer';
import { videoMaskOverlays } from '@/entrypoints/content/presentation/videoMaskOverlay';
import { engageAudioDelay, releaseAudioDelay, updateAudioDelay } from '@/entrypoints/content/video/dvr/audioDelay';
import { computeDvrDelayMs, LATENCY_SAMPLE_COUNT, MAX_DVR_DELAY_MS } from '@/entrypoints/content/video/dvr/delay';
import { FrameRing } from '@/entrypoints/content/video/dvr/frameRing';
import { VerdictTrack } from '@/entrypoints/content/video/dvr/verdictTrack';
import {
  captureFrameBitmap,
  captureThumbnailBitmap,
  releaseCorsVideoCache,
} from '@/entrypoints/content/video/frameCapture';
import { PermanentFrameTransferError } from '@/entrypoints/content/video/frameTransfer';
import {
  createVideoSession,
  reduce,
  type SessionEffect,
  type SessionEvent,
  type SessionStatus,
  type SessionTimer,
  type VideoSessionState,
} from '@/entrypoints/content/video/session/machine';
import { INFERENCE_PRIORITY } from '@/utils/constants/inference';
import { logger } from '@/utils/logger';
import { buildMaskingFilter } from '@/utils/masking';

import type { CapturedFrameSample, PendingFrameSample } from '@/entrypoints/content/video/frameSample';
import type { IFramePrediction, IHostSettings, IImagePrediction } from '@/utils/types';

const log = logger.withTag('videoSession');

const STATUS_TO_PROCESSED: Record<SessionStatus, ProcessedStatus> = {
  safe: 'safe',
  unsafe: 'unsafe',
  skipped: 'skipped',
};

/**
 * Ceiling on one capture+send round. The machine frees the in-flight slot on
 * sendFailed, but only if the promise settles: a CORS-clone or poster load on
 * a blackholed network fires neither 'loadeddata' nor 'error' and would
 * otherwise occupy the slot forever, stalling sampling under the watchdog blur.
 */
const CAPTURE_SEND_TIMEOUT_MS = 10_000;

/** Buffer captures are cheaper and denser than inference samples (~13 fps). */
const DVR_CAPTURE_INTERVAL_SEC = 1 / 15;
/** Buffered frames are presentation-sized, not inference-sized. */
const DVR_CAPTURE_MAX_WIDTH = 640;
/** Ring horizon: the adaptive delay's ceiling plus slack, so a growing D still finds frames. */
const DVR_BUFFER_HORIZON_SEC = MAX_DVR_DELAY_MS / 1000 + 1;
/** Per-session byte cap (~4.5 s of 640×360 RGBA at 15 fps ≈ 62 MB); only while masked. */
const DVR_BUFFER_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A verdict that never arrives leaves its pending Frame Sample behind (the
 * sampleTimeout only frees the machine's slot), so an inference outage would
 * grow the map for the session's lifetime. Entries this old are useless to the
 * delay estimator anyway — prune them on the next send.
 */
const SAMPLE_LATENCY_EXPIRY_MS = 30_000;

/** Keep near-viewport players warm while dropping scrolled-away feed videos. */
const VIDEO_VISIBILITY_ROOT_MARGIN_PX = 400;

/**
 * A masked playing video pays a full DVR teardown + re-warm (seconds of
 * whole-blur) and an audio-delay bounce per suspend/resume flip, so boundary
 * flapping in a virtualized feed (layout shifts, elastic scroll) must not
 * toggle suspension directly: leaving the margin only suspends after this
 * grace period; re-entering resumes immediately and cancels a pending suspend.
 */
const VIDEO_SUSPEND_GRACE_MS = 1_000;

function withTimeout<T>(promise: Promise<T>, label: string, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timed out after ${CAPTURE_SEND_TIMEOUT_MS}ms`));
    }, CAPTURE_SEND_TIMEOUT_MS);
    promise.then(
      value => {
        clearTimeout(timer);
        if (timedOut) onLate?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * crypto.randomUUID is undefined in non-secure contexts (plain http: pages,
 * which content scripts on <all_urls> do reach); getRandomValues is not.
 */
function generateSessionId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

interface DvrRuntime {
  ring: FrameRing;
  track: VerdictTrack;
  player: VideoDvrPlayer;
  /** Throttles buffer captures below the tick rate (rVFC ticks are denser). */
  lastCapturedMediaTime: number;
}

interface SessionHandle {
  readonly sessionId: string;
  readonly video: HTMLVideoElement;
  /** Object-backed sources have no URL; retain their identity for source-change detection. */
  readonly srcObject: HTMLVideoElement['srcObject'];
  readonly src: string;
  hostSettings: IHostSettings;
  state: VideoSessionState;
  lastPrediction: IFramePrediction | null;
  /** Most recent unsafe prediction: what `applyVerdict` renders (pause re-masks need it). */
  lastUnsafePrediction: IFramePrediction | null;
  timers: Map<SessionTimer, ReturnType<typeof setTimeout>>;
  stopTicker: (() => void) | null;
  removeListeners: () => void;
  /** Serializes async overlay work so verdicts render in dispatch order. */
  overlayChain: Promise<void>;
  dvr: DvrRuntime | null;
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

interface PendingAdoption {
  hostSettings: IHostSettings;
  cancel: () => void;
}

interface ResolvedVideoSource {
  srcObject: HTMLVideoElement['srcObject'];
  url: string;
}

/** `srcObject` is the active source even if a previous URL is still reflected temporarily. */
function resolveVideoSource(video: HTMLVideoElement): ResolvedVideoSource | null {
  if (video.srcObject) return { srcObject: video.srcObject, url: '' };
  const url = video.currentSrc || video.src;
  return url ? { srcObject: null, url } : null;
}

function isSameVideoSource(handle: SessionHandle, source: ResolvedVideoSource): boolean {
  return source.srcObject
    ? handle.srcObject === source.srcObject
    : handle.srcObject === null && handle.src === source.url;
}

function isVideoNearViewport(video: HTMLVideoElement): boolean {
  if (typeof IntersectionObserver !== 'function') return true;
  const rect = video.getBoundingClientRect();
  // No layout box (display:none player behind a poster overlay, not laid out
  // yet): it can never intersect, but thumbnail capture works from data/poster
  // and the reveal must find its verdict ready. Only real scroll-aways suspend.
  if (rect.width <= 0 || rect.height <= 0) return true;
  return (
    rect.bottom >= -VIDEO_VISIBILITY_ROOT_MARGIN_PX &&
    rect.top <= globalThis.innerHeight + VIDEO_VISIBILITY_ROOT_MARGIN_PX &&
    rect.right >= 0 &&
    rect.left <= globalThis.innerWidth
  );
}

/**
 * Whole-video blur is applied inline: the BLUR_CLASS stylesheet lives in the
 * document and does not reach videos inside shadow roots. The class stays on
 * as the state marker.
 */
function applyWholeBlur(video: HTMLVideoElement, hostSettings: IHostSettings): void {
  if (!video.classList.contains(BLUR_CLASS) && video.style.filter) {
    video.dataset.hbOriginalFilter = video.style.filter;
  }
  video.classList.add(BLUR_CLASS);
  video.style.setProperty('filter', buildMaskingFilter(hostSettings.masking), 'important');
}

function clearWholeBlur(video: HTMLVideoElement): void {
  video.classList.remove(BLUR_CLASS);
  const original = video.dataset.hbOriginalFilter;
  delete video.dataset.hbOriginalFilter;
  if (original) {
    video.style.setProperty('filter', original);
  } else {
    video.style.removeProperty('filter');
  }
}

class VideoSessionRegistry {
  private readonly byId = new Map<string, SessionHandle>();
  private readonly byVideo = new WeakMap<HTMLVideoElement, SessionHandle>();
  /** Videos awaiting a resolved source; strong so disposeAll/sweep can cancel the waits. */
  private readonly pendingByVideo = new Map<HTMLVideoElement, PendingAdoption>();
  private visibilityObserver: IntersectionObserver | null = null;

  /**
   * Adopt a video, creating its VideoSession. A video without a resolved
   * source yet is adopted as soon as resource selection yields one.
   * Re-adopting the same (element, source) pair only refreshes host settings;
   * a changed source disposes the old session and starts a fresh one.
   */
  adopt(video: HTMLVideoElement, hostSettings: IHostSettings): void {
    this.sweepDisconnected();
    const source = resolveVideoSource(video);
    if (!source) {
      this.awaitResolvedSource(video, hostSettings);
      return;
    }
    this.pendingByVideo.get(video)?.cancel();

    const existing = this.byVideo.get(video);
    if (existing) {
      if (isSameVideoSource(existing, source) && existing.state.phase !== 'disposed') {
        existing.hostSettings = hostSettings;
        return;
      }
      this.dispose(video);
    }

    const sessionId = generateSessionId();
    const handle: SessionHandle = {
      sessionId,
      video,
      srcObject: source.srcObject,
      // Object-backed streams lack a persistent media URL. A session-local
      // label preserves sample metadata without pretending it is cacheable.
      src: source.url || `srcobject:${sessionId}`,
      hostSettings,
      state: null as unknown as VideoSessionState, // set right below via createVideoSession
      lastPrediction: null,
      lastUnsafePrediction: null,
      timers: new Map(),
      stopTicker: null,
      removeListeners: () => {},
      overlayChain: Promise.resolve(),
      dvr: null,
      pendingSamples: new Map(),
      latenciesMs: [],
      suspended: !isVideoNearViewport(video),
      suspendGrace: null,
      captureEpoch: 0,
      pendingThumbnailCapture: false,
      pendingResample: false,
      sentPlaybackFrame: false,
    };
    this.byId.set(handle.sessionId, handle);
    this.byVideo.set(video, handle);
    video.dataset.hbSrc = handle.src;
    video.dataset.hbSessionId = handle.sessionId;

    const born = createVideoSession();
    handle.state = born.state;
    this.execute(handle, born.effects);

    this.bindMediaEvents(handle);
    this.observeVisibility(handle);
    if (!handle.suspended) this.startTicker(handle);
    this.queueThumbnailSourceReady(handle);
  }

  /** Route a batch of frame predictions to their sessions; unknown sessions are dropped. */
  handlePredictions(preds: IFramePrediction[]): void {
    this.sweepDisconnected();
    for (const pred of preds) {
      const handle = this.byId.get(pred.sessionId);
      if (!handle) {
        log.debug('Dropping prediction for unknown session:', pred.sessionId);
        continue;
      }
      handle.lastPrediction = pred;
      const unsafe = Boolean(pred.predictions?.length);
      const sample = handle.pendingSamples.get(pred.frameIndex);
      if (sample) {
        handle.pendingSamples.delete(pred.frameIndex);
        handle.latenciesMs.push(performance.now() - sample.capturedAt);
        if (handle.latenciesMs.length > LATENCY_SAMPLE_COUNT) handle.latenciesMs.shift();
        // Keep the audio delay tracking the adaptive presentation delay.
        if (handle.dvr) updateAudioDelay(handle.video, computeDvrDelayMs(handle.latenciesMs) / 1000);
      }
      this.dispatchPrediction(handle, pred, {
        type: 'predictionReceived',
        frameIndex: pred.frameIndex,
        unsafe,
        at: performance.now(),
      });
      // After the dispatch: an unsafe verdict may have just started the DVR,
      // and its own entry must land in the track. Verdicts are keyed by media
      // time, so even machine-stale (older-index) ones describe their frame;
      // the Thumbnail (frame −1) has no media time and stays out.
      if (handle.dvr && pred.frameIndex >= 0) {
        handle.dvr.track.add({
          timestampSec: pred.timestampSec,
          unsafe,
          predictions: pred.predictions ?? [],
          maskTransform: pred.maskTransform,
          width: pred.width,
          height: pred.height,
        });
      }
    }
  }

  /** Dispose the session bound to this element (source change or removal). */
  dispose(video: HTMLVideoElement): void {
    const pending = this.pendingByVideo.get(video);
    pending?.cancel();
    const handle = this.byVideo.get(video);
    if (!handle) {
      if (pending) clearWholeBlur(video);
      return;
    }
    this.dispatch(handle, { type: 'dispose' });
  }

  disposeAll(): void {
    for (const [video, pending] of [...this.pendingByVideo]) {
      pending.cancel();
      clearWholeBlur(video);
    }
    for (const handle of this.byId.values()) {
      this.dispatch(handle, { type: 'dispose' });
    }
  }

  /**
   * A video with no resolved source yet (<source> children still selecting,
   * MSE, late src assignment) is adopted when resource selection yields one:
   * 'loadstart' fires whenever selection begins — even with preload="none".
   * Object-backed media is adopted as soon as `srcObject` becomes available,
   * despite having no URL in `currentSrc` or `src`.
   * The wait lives in the registry so re-discovery refreshes its settings and
   * dispose/disposeAll cancel it; it cannot outlive the pipeline.
   */
  private awaitResolvedSource(video: HTMLVideoElement, hostSettings: IHostSettings): void {
    const pending = this.pendingByVideo.get(video);
    if (pending) {
      pending.hostSettings = hostSettings;
      return;
    }
    // Fail closed during the wait: a src-less video still displays its poster.
    // Adoption re-applies the blur (idempotent); it never lifts here, so the
    // wait→ADOPTED handoff has no unprotected gap.
    applyWholeBlur(video, hostSettings);
    const entry: PendingAdoption = { hostSettings, cancel: () => {} };
    const onLoadstart = () => {
      if (!resolveVideoSource(video)) return;
      entry.cancel();
      this.adopt(video, entry.hostSettings);
    };
    entry.cancel = () => {
      video.removeEventListener('loadstart', onLoadstart);
      this.pendingByVideo.delete(video);
    };
    this.pendingByVideo.set(video, entry);
    video.addEventListener('loadstart', onLoadstart);
  }

  /**
   * Reclaim sessions whose element left the document without a removal
   * notification (e.g. deeply nested shadow-root teardown). byId is a strong
   * Map, so a missed dispose would otherwise leak the handle and element.
   */
  private sweepDisconnected(): void {
    for (const handle of this.byId.values()) {
      if (!handle.video.isConnected) {
        this.dispatch(handle, { type: 'dispose' });
      }
    }
    for (const [video, pending] of this.pendingByVideo) {
      if (!video.isConnected) {
        pending.cancel();
      }
    }
  }

  private dispatch(handle: SessionHandle, event: SessionEvent): void {
    const { state, effects } = reduce(handle.state, event);
    handle.state = state;
    this.execute(handle, effects);
  }

  private observeVisibility(handle: SessionHandle): void {
    if (typeof IntersectionObserver !== 'function') return;
    this.visibilityObserver ??= new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const video = entry.target as HTMLVideoElement;
          const current = this.byVideo.get(video);
          if (!current) continue;
          // Boxless players never intersect; mirror isVideoNearViewport's
          // carve-out so hidden-then-revealed videos keep their eager verdict.
          const rect = entry.boundingClientRect;
          const offscreen = !entry.isIntersecting && rect.width > 0 && rect.height > 0;
          this.requestSuspended(current, offscreen);
        }
      },
      { rootMargin: `${VIDEO_VISIBILITY_ROOT_MARGIN_PX}px 0px` },
    );
    this.visibilityObserver.observe(handle.video);
  }

  /** Suspension waits out a grace period so boundary flapping cannot thrash the DVR; resume is immediate. */
  private requestSuspended(handle: SessionHandle, suspended: boolean): void {
    if (!suspended) {
      this.clearSuspendGrace(handle);
      this.setSuspended(handle, false);
      return;
    }
    if (handle.suspended || handle.suspendGrace !== null) return;
    handle.suspendGrace = setTimeout(() => {
      handle.suspendGrace = null;
      this.setSuspended(handle, true);
    }, VIDEO_SUSPEND_GRACE_MS);
  }

  private clearSuspendGrace(handle: SessionHandle): void {
    if (handle.suspendGrace === null) return;
    clearTimeout(handle.suspendGrace);
    handle.suspendGrace = null;
  }

  private setSuspended(handle: SessionHandle, suspended: boolean): void {
    if (handle.suspended === suspended || handle.state.phase === 'disposed') return;
    handle.suspended = suspended;
    if (suspended) {
      // Invalidate captures already in flight: one resolving after a fast
      // suspend→resume must not send its pre-suspension frame (it would evict
      // a fresher queued frame in the background and restart sampleTimeout).
      handle.captureEpoch += 1;
      if (handle.sentPlaybackFrame) void cancelVideoSessionInference(handle.sessionId);
      const { inflightIndex } = handle.state;
      if (inflightIndex !== null) {
        handle.pendingSamples.delete(inflightIndex);
        // The displayed frame loses its pending verdict; a paused resume must re-sample it.
        handle.pendingResample = true;
        this.dispatch(handle, { type: 'sampleCancelled', frameIndex: inflightIndex, at: performance.now() });
      }
      // Reuse the machine's playback hand-back so DVR state, audio, and the
      // ring are released consistently, then stop frame delivery entirely.
      if (handle.state.phase === 'sampling') {
        this.dispatch(handle, { type: 'pause', at: performance.now() });
      }
      handle.stopTicker?.();
      handle.stopTicker = null;
      return;
    }

    this.startTicker(handle);
    if (handle.pendingThumbnailCapture) {
      handle.pendingThumbnailCapture = false;
      // Replay whenever the session is still verdict-less, not only in
      // THUMBNAILING: play can preempt readiness, leaving the machine to
      // re-signal captureThumbnail from standby/sampling with no timer armed —
      // gating on phase would strand the deferred capture and the blur forever.
      if (handle.state.lastAppliedIndex === Number.NEGATIVE_INFINITY && handle.state.phase !== 'error') {
        void this.captureAndSend(handle, -1, 0);
      }
    }
    if (!handle.video.paused && !handle.video.ended) {
      handle.pendingResample = false; // fresh playback sampling supersedes it
      this.dispatch(handle, { type: 'play', at: performance.now() });
    } else {
      if (handle.state.masked) {
        // Static unsafe frame returning to view: replace the coarse suspension
        // blur with its precise overlay now that it has real geometry again.
        applyWholeBlur(handle.video, handle.hostSettings);
        this.applyVerdictOverlay(handle, true);
      }
      if (handle.pendingResample) {
        handle.pendingResample = false;
        // A sample deflected during suspension (page-driven seek, cancelled
        // in-flight) left the displayed frame unverified, and a paused video
        // produces no further events — sample it like a fresh seek.
        this.dispatch(handle, { type: 'seeked', at: performance.now(), timestampSec: handle.video.currentTime });
      }
    }
  }

  private startTicker(handle: SessionHandle): void {
    // 'error' keeps its ticker stopped by the machine's own stopTicker/resumeTicker
    // protocol (cooldown expiry re-arms it); a viewport resume must not override that.
    if (handle.stopTicker || handle.suspended) return;
    if (handle.state.phase === 'disposed' || handle.state.phase === 'error') return;
    handle.stopTicker = startFrameTicker(handle.video, (at, mediaTime) => {
      this.dispatch(handle, { type: 'frameAvailable', at, timestampSec: mediaTime });
      this.captureIntoRing(handle, mediaTime);
    });
  }

  /** Commit adapter state only for verdicts accepted by the reducer's ordering rule. */
  private dispatchPrediction(
    handle: SessionHandle,
    prediction: IFramePrediction,
    event: Extract<SessionEvent, { type: 'predictionReceived' }>,
  ): void {
    const previousLastAppliedIndex = handle.state.lastAppliedIndex;
    const { state, effects } = reduce(handle.state, event);
    handle.state = state;
    if (event.unsafe && event.frameIndex > previousLastAppliedIndex && state.lastAppliedIndex === event.frameIndex) {
      // Set before executing effects: applyVerdict reads this synchronously.
      handle.lastUnsafePrediction = prediction;
    }
    this.execute(handle, effects);
  }

  private execute(handle: SessionHandle, effects: SessionEffect[]): void {
    const { video } = handle;
    for (const effect of effects) {
      switch (effect.kind) {
        case 'applyBlur':
          applyWholeBlur(video, handle.hostSettings);
          break;
        case 'clearBlur':
          clearWholeBlur(video);
          break;
        case 'captureThumbnail':
          if (handle.suspended) {
            handle.pendingThumbnailCapture = true;
          } else {
            handle.pendingThumbnailCapture = false;
            void this.captureAndSend(handle, -1, 0);
          }
          break;
        case 'sendSample':
          void this.captureAndSend(handle, effect.frameIndex, effect.timestampSec);
          break;
        case 'applyVerdict':
          if (!handle.suspended) this.applyVerdictOverlay(handle);
          break;
        case 'applyVerdictThenClearBlur':
          if (!handle.suspended) this.applyVerdictOverlay(handle, true);
          break;
        case 'clearVerdict':
          // Serialized behind pending renders: a slow applyVerdict must never
          // finish after the clear and resurrect a mask on a clean video.
          this.queueOverlayTask(handle, () => {
            videoMaskOverlays.clearMaskOverlay(video);
          });
          break;
        case 'setStatus':
          clearProcessedStatus(video);
          video.setAttribute(PROCESSED_ATTR_MAP[STATUS_TO_PROCESSED[effect.status]], '');
          break;
        case 'startTimer': {
          const pending = handle.timers.get(effect.timer);
          if (pending) clearTimeout(pending);
          handle.timers.set(
            effect.timer,
            setTimeout(() => {
              handle.timers.delete(effect.timer);
              this.dispatch(handle, { type: 'timerFired', timer: effect.timer, at: performance.now() });
            }, effect.ms),
          );
          break;
        }
        case 'cancelTimer': {
          const pending = handle.timers.get(effect.timer);
          if (pending) clearTimeout(pending);
          handle.timers.delete(effect.timer);
          break;
        }
        case 'stopTicker':
          handle.stopTicker?.();
          handle.stopTicker = null;
          break;
        case 'resumeTicker':
          // Error-cooldown expiry: re-arm frame delivery, and if the video is
          // mid-playback there will be no fresh 'play' event — synthesize one.
          handle.stopTicker?.();
          handle.stopTicker = null;
          this.startTicker(handle);
          if (!handle.suspended && !video.paused && !video.ended) {
            this.dispatch(handle, { type: 'play', at: performance.now() });
          }
          break;
        case 'startDvr':
          this.startDvr(handle);
          break;
        case 'stopDvr':
          this.stopDvr(handle);
          break;
        case 'cleanup':
          this.teardown(handle);
          break;
      }
    }
  }

  private startDvr(handle: SessionHandle): void {
    if (handle.dvr) return;
    const ring = new FrameRing(DVR_BUFFER_HORIZON_SEC, DVR_BUFFER_MAX_BYTES);
    const track = new VerdictTrack();
    const player = new VideoDvrPlayer({
      video: handle.video,
      ring,
      track,
      // Live: D follows the session's observed sample→verdict round-trips, so a
      // slow page (HD frames, busy queue) gets a longer delay instead of holes.
      getDelaySec: () => computeDvrDelayMs(handle.latenciesMs) / 1000,
      getMasking: () => handle.hostSettings.masking,
      onReady: () => {
        this.dispatch(handle, { type: 'bufferReady', at: performance.now() });
        // The canvas now presents D behind the live edge; delay audio to match.
        void engageAudioDelay(
          handle.video,
          computeDvrDelayMs(handle.latenciesMs) / 1000,
          () => handle.dvr?.player === player,
        );
      },
    });
    handle.dvr = {
      ring,
      track,
      player,
      lastCapturedMediaTime: Number.NEGATIVE_INFINITY,
    };
  }

  private stopDvr(handle: SessionHandle): void {
    const { dvr } = handle;
    if (!dvr) return;
    handle.dvr = null;
    releaseAudioDelay(handle.video);
    dvr.player.destroy();
    dvr.ring.release();
  }

  /**
   * Feed the ring while the DVR is active: presentation-sized, throttled below
   * the tick rate. Buffering is display-only (no pixel readback), so it works
   * even for sources whose pixels inference may not read — the taint just
   * travels with the bitmap onto the presentation canvas.
   */
  private captureIntoRing(handle: SessionHandle, mediaTime: number): void {
    const { dvr } = handle;
    if (!dvr) return;
    if (mediaTime - dvr.lastCapturedMediaTime < DVR_CAPTURE_INTERVAL_SEC && mediaTime >= dvr.lastCapturedMediaTime) {
      return;
    }
    try {
      const { video } = handle;
      const nativeWidth = video.videoWidth;
      const nativeHeight = video.videoHeight;
      if (!nativeWidth || !nativeHeight) return;
      // Downscale through a canvas, NOT createImageBitmap's resize options:
      // Firefox never implemented those, and per WebIDL silently ignores them —
      // native-resolution HD frames then blow the ring's byte budget, its span
      // never reaches the presentation delay, and the DVR warms forever.
      const scale = Math.min(1, DVR_CAPTURE_MAX_WIDTH / nativeWidth);
      const width = Math.max(1, Math.round(nativeWidth * scale));
      const height = Math.max(1, Math.round(nativeHeight * scale));
      const surface = new OffscreenCanvas(width, height);
      const ctx = surface.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);
      // transferToImageBitmap needs no readback, so this works (display-only,
      // taint carried along) even for sources whose pixels we may not read.
      const bitmap = surface.transferToImageBitmap();
      dvr.lastCapturedMediaTime = mediaTime;
      dvr.ring.push({ bitmap, mediaTime });
    } catch (error) {
      log.debug('DVR buffer capture failed:', error);
    }
  }

  private teardown(handle: SessionHandle): void {
    const { video } = handle;
    if (handle.sentPlaybackFrame) void cancelVideoSessionInference(handle.sessionId);
    this.clearSuspendGrace(handle);
    this.stopDvr(handle);
    for (const pending of handle.timers.values()) clearTimeout(pending);
    handle.timers.clear();
    handle.stopTicker?.();
    handle.stopTicker = null;
    handle.pendingSamples.clear();
    handle.removeListeners();
    this.visibilityObserver?.unobserve(video);
    videoMaskOverlays.clearMaskOverlay(video);
    clearWholeBlur(video);
    clearProcessedStatus(video);
    releaseCorsVideoCache(video);
    delete video.dataset.hbSrc;
    delete video.dataset.hbSessionId;
    this.byId.delete(handle.sessionId);
    if (this.byVideo.get(video) === handle) {
      this.byVideo.delete(video);
    }
  }

  /** Media events feed the machine; a source change re-adopts under the stored settings. */
  private bindMediaEvents(handle: SessionHandle): void {
    const { video } = handle;
    const now = () => performance.now();

    const onPlay = () => {
      if (!handle.suspended) this.dispatch(handle, { type: 'play', at: now() });
    };
    const onPause = () => this.dispatch(handle, { type: 'pause', at: now() });
    const onEnded = () => this.dispatch(handle, { type: 'ended', at: now() });
    const onSeeked = () => this.dispatch(handle, { type: 'seeked', at: now(), timestampSec: video.currentTime });
    const onSourceChanged = () => {
      const current = resolveVideoSource(video);
      if (current && isSameVideoSource(handle, current)) return;
      // New or removed source on the same element: the old VideoSession (and
      // its blur, overlays, and status) dies with the content it described. A
      // new session is born now, or once the next source resolves. 'emptied'
      // matters because removeAttribute('src') + load() never fires loadstart.
      const settings = handle.hostSettings;
      this.dispose(video);
      this.adopt(video, settings);
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadstart', onSourceChanged);
    video.addEventListener('emptied', onSourceChanged);

    handle.removeListeners = () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadstart', onSourceChanged);
      video.removeEventListener('emptied', onSourceChanged);
    };

    // A video already playing at adoption goes straight to sampling.
    if (!video.paused && !video.ended) {
      onPlay();
    }
  }

  /**
   * Signal Thumbnail readiness: a poster needs no video data at all; otherwise
   * wait for the first frame. preload="none" without a poster stays in ADOPTED
   * (blurred, nothing rendered) until data or playback arrives.
   */
  private queueThumbnailSourceReady(handle: SessionHandle): void {
    const { video } = handle;
    const ready = () => this.dispatch(handle, { type: 'thumbnailSourceReady' });

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      ready();
      return;
    }
    if (video.poster) {
      // Try the poster now. If it fails to load, capture fails closed (no frame
      // data yet), so also re-signal once data arrives; the machine re-captures
      // only while the session is still verdict-less.
      ready();
    }
    video.addEventListener('loadeddata', ready, { once: true });
    const prevRemove = handle.removeListeners;
    handle.removeListeners = () => {
      prevRemove();
      video.removeEventListener('loadeddata', ready);
    };
  }

  private async captureAndSend(handle: SessionHandle, frameIndex: number, timestampSec: number): Promise<void> {
    const { video } = handle;
    const isDisposed = () => handle.state.phase === 'disposed';
    if (isDisposed()) return;
    if (handle.suspended) {
      if (frameIndex === -1) {
        handle.pendingThumbnailCapture = true;
      } else {
        handle.pendingResample = true;
        this.dispatch(handle, { type: 'sampleCancelled', frameIndex, at: performance.now() });
      }
      return;
    }
    const epoch = handle.captureEpoch;
    // Frame Sample identity is fixed by the event that selected the frame
    // (rVFC mediaTime or seeked currentTime), never reread after async capture.
    const capturedAt = performance.now();
    const pendingSample: PendingFrameSample = {
      sessionId: handle.sessionId,
      frameIndex,
      videoUrl: handle.src,
      timestampSec,
      capturedAt,
    };
    // Round-trip is measured from capture start, the span the DVR delay covers.
    if (frameIndex >= 0) {
      for (const [index, sample] of handle.pendingSamples) {
        if (capturedAt - sample.capturedAt > SAMPLE_LATENCY_EXPIRY_MS) handle.pendingSamples.delete(index);
      }
      handle.pendingSamples.set(frameIndex, pendingSample);
    }
    try {
      const captured = await withTimeout(
        frameIndex === -1 ? captureThumbnailBitmap(video) : captureFrameBitmap(video, timestampSec),
        'Frame Sample capture',
        late => late.bitmap?.close(),
      );
      // Capture is async: the session may have died (source change, removal)
      // while we awaited. A dead session must not send work to inference.
      if (isDisposed()) {
        captured.bitmap?.close();
        return;
      }
      // Epoch mismatch: a suspend happened mid-capture (even if since resumed).
      // The machine already freed this slot and a fresher frame may be queued
      // behind it — sending now would resurrect the cancelled sample. Stale
      // thumbnails stay valid: frame −1 has no timeline position.
      if (handle.suspended || (frameIndex >= 0 && handle.captureEpoch !== epoch)) {
        captured.bitmap?.close();
        handle.pendingSamples.delete(frameIndex);
        if (frameIndex === -1) {
          handle.pendingThumbnailCapture = true;
        } else {
          if (handle.suspended) handle.pendingResample = true;
          this.dispatch(handle, { type: 'sampleCancelled', frameIndex, at: performance.now() });
        }
        return;
      }
      const { bitmap } = captured;
      if (!bitmap || bitmap.width === 0 || bitmap.height === 0) {
        bitmap?.close();
        handle.pendingSamples.delete(frameIndex);
        this.dispatch(handle, {
          type: 'sendFailed',
          frameIndex,
          at: performance.now(),
          permanent: captured.failure === 'permanent',
        });
        return;
      }
      const sample: CapturedFrameSample = {
        ...pendingSample,
        bitmap,
        originalWidth: video.videoWidth,
        originalHeight: video.videoHeight,
      };
      // Set before the transport await: a timed-out send may still deliver,
      // so a later cancel RPC must not be skipped for it.
      if (frameIndex >= 0) handle.sentPlaybackFrame = true;
      await withTimeout(
        requestVideoFrameInference({
          sample,
          hostname: handle.hostSettings.hostname,
          priority: frameIndex === -1 ? INFERENCE_PRIORITY.videoThumbnail : INFERENCE_PRIORITY.videoFrame,
        }),
        'Frame Sample send',
      );
      this.dispatch(handle, { type: 'sampleSent', frameIndex, at: performance.now() });
    } catch (error) {
      const permanent = error instanceof PermanentFrameTransferError;
      if (permanent) log.warn('Frame Sample cannot be serialized for inference:', error);
      else log.error('Frame Sample capture/send failed:', error);
      handle.pendingSamples.delete(frameIndex);
      this.dispatch(handle, { type: 'sendFailed', frameIndex, at: performance.now(), permanent });
    }
  }

  /**
   * Overlay work is async; serialize per session so an older render can never
   * finish after a newer render or clear, and a disposed session's in-flight
   * work cannot resurrect DOM state after teardown.
   */
  private queueOverlayTask(handle: SessionHandle, task: () => Promise<void> | void): void {
    const isDisposed = () => handle.state.phase === 'disposed';
    handle.overlayChain = handle.overlayChain.then(async () => {
      if (isDisposed()) return;
      try {
        await task();
      } catch (error) {
        log.error('Overlay work failed:', error);
      }
    });
  }

  private applyVerdictOverlay(handle: SessionHandle, clearBlurOnPaint = false): void {
    // The last unsafe prediction, not the last one: a pause-time re-mask must
    // render the mask that made the session masked, not a newer clean verdict.
    const pred = handle.lastUnsafePrediction;
    if (!pred) return;
    const { video, hostSettings } = handle;
    const imagePrediction = toImagePrediction(pred);
    this.queueOverlayTask(handle, async () => {
      // The session may have moved on while this render waited in the chain
      // (playback started, the DVR claimed the element): attaching the overlay
      // slot now would evict the live DVR presenter, leaving the machine
      // convinced the DVR still masks. Whenever the DVR is active it (or its
      // warm-up whole-blur) owns masking, so a stale static render is never
      // wanted — a later pause re-mask regenerates it from lastUnsafePrediction.
      const staleRender = () => handle.state.phase === 'disposed' || handle.state.dvr !== 'off';
      if (staleRender()) return;
      await videoMaskOverlays.createMaskOverlay(video, imagePrediction, hostSettings, staleRender);
      if (handle.state.phase === 'disposed') {
        // Disposed mid-render: undo what the render just re-created.
        videoMaskOverlays.clearMaskOverlay(video);
      } else if (clearBlurOnPaint && !staleRender() && videoMaskOverlays.hasMaskOverlay(video)) {
        // Never reveal the native unsafe frame before a real overlay exists.
        // If rendering failed or became stale, leave the protection in place.
        clearWholeBlur(video);
      }
    });
  }
}

function toImagePrediction(framePred: IFramePrediction): IImagePrediction {
  return {
    src: framePred.videoUrl,
    predictions: framePred.predictions,
    width: framePred.width,
    height: framePred.height,
    hostname: framePred.hostname,
    timestamp: framePred.timestamp,
    cacheMetadata: framePred.cacheMetadata,
    maskTransform: framePred.maskTransform,
    processingTime: framePred.processingTime,
    forcedVisibility: 'auto',
  };
}

/**
 * Drive frameAvailable events from actual frame presentation. rVFC fires only
 * when a new video frame is presented (never for a stalled/paused video); the
 * rAF fallback is gated on playback state instead. `mediaTime` is the
 * presented frame's position on the media timeline (the DVR ring's key).
 */
function startFrameTicker(video: HTMLVideoElement, onFrame: (at: number, mediaTime: number) => void): () => void {
  if (typeof video.requestVideoFrameCallback === 'function') {
    let stopped = false;
    let callbackId = 0;
    const loop = () => {
      callbackId = video.requestVideoFrameCallback((now, metadata) => {
        if (stopped) return;
        onFrame(now, metadata.mediaTime);
        loop();
      });
    };
    loop();
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback(callbackId);
    };
  }

  // rAF fallback: run only while playing. Unlike rVFC, rAF fires before frame
  // data exists; skip those ticks so capture never sees a data-less video.
  let rafId: number | null = null;
  const tick = () => {
    rafId = null;
    if (video.paused || video.ended) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      onFrame(performance.now(), video.currentTime);
    }
    rafId = requestAnimationFrame(tick);
  };
  const start = () => {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  };
  video.addEventListener('play', start);
  video.addEventListener('pause', stop);
  video.addEventListener('ended', stop);
  if (!video.paused && !video.ended) start();
  return () => {
    stop();
    video.removeEventListener('play', start);
    video.removeEventListener('pause', stop);
    video.removeEventListener('ended', stop);
  };
}

export const videoSessions = new VideoSessionRegistry();
