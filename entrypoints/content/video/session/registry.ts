/**
 * VideoSession registry: the lifecycle module (docs/VIDEO_PROCESSING.md).
 *
 * Owns every live VideoSession (element × resolved source), routes frame
 * predictions by sessionId (no DOM queries), and runs the dispatch loop that
 * feeds the pure machine and routes its effects to the executing modules:
 * sampling (frameSampler.ts), viewport suspension (viewportSuspension.ts),
 * and presentation (presentationAdapter.ts).
 */

import {
  clearProcessedStatus,
  PROCESSED_ATTR_MAP,
  type ProcessedStatus,
} from '@/entrypoints/content/presentation/initialStyling';
import { videoMaskOverlays } from '@/entrypoints/content/presentation/videoMaskOverlay';
import { releaseCorsVideoCache } from '@/entrypoints/content/video/frameCapture';
import { FrameSampler } from '@/entrypoints/content/video/session/frameSampler';
import {
  createVideoSession,
  reduce,
  type SessionEffect,
  type SessionEvent,
  type SessionStatus,
  type VideoSessionState,
} from '@/entrypoints/content/video/session/machine';
import {
  applyWholeBlur,
  clearWholeBlur,
  PresentationAdapter,
} from '@/entrypoints/content/video/session/presentationAdapter';
import { isVideoNearViewport, ViewportSuspension } from '@/entrypoints/content/video/session/viewportSuspension';
import { logger } from '@/utils/logger';

import type { SessionHandle } from '@/entrypoints/content/video/session/handle';
import type { IFramePrediction, IHostSettings } from '@/utils/types';

const log = logger.withTag('videoSession');

const STATUS_TO_PROCESSED: Record<SessionStatus, ProcessedStatus> = {
  safe: 'safe',
  unsafe: 'unsafe',
  skipped: 'skipped',
};

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

class VideoSessionRegistry {
  private readonly byId = new Map<string, SessionHandle>();
  private readonly byVideo = new WeakMap<HTMLVideoElement, SessionHandle>();
  /** Videos awaiting a resolved source; strong so disposeAll/sweep can cancel the waits. */
  private readonly pendingByVideo = new Map<HTMLVideoElement, PendingAdoption>();

  private readonly presentation = new PresentationAdapter({
    dispatch: (handle, event) => this.dispatch(handle, event),
  });

  private readonly sampler = new FrameSampler({
    dispatch: (handle, event) => this.dispatch(handle, event),
    captureIntoRing: (handle, mediaTime) => this.presentation.captureIntoRing(handle, mediaTime),
  });

  private readonly suspension = new ViewportSuspension({
    handleFor: video => this.byVideo.get(video),
    dispatch: (handle, event) => this.dispatch(handle, event),
    sampler: this.sampler,
    reapplyStaticMask: handle => {
      applyWholeBlur(handle.video, handle.hostSettings);
      this.presentation.applyVerdictOverlay(handle, true);
    },
  });

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
    this.suspension.observe(handle);
    if (!handle.suspended) this.sampler.startTicker(handle);
    this.sampler.queueThumbnailSourceReady(handle);
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
      if (this.sampler.recordVerdictLatency(handle, pred.frameIndex)) {
        this.presentation.syncAudioDelay(handle);
      }
      this.dispatchPrediction(handle, pred, {
        type: 'predictionReceived',
        frameIndex: pred.frameIndex,
        unsafe,
        at: performance.now(),
      });
      this.presentation.recordVerdict(handle, pred, unsafe);
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
          this.sampler.captureThumbnail(handle);
          break;
        case 'sendSample':
          void this.sampler.captureAndSend(handle, effect.frameIndex, effect.timestampSec);
          break;
        case 'applyVerdict':
          if (!handle.suspended) this.presentation.applyVerdictOverlay(handle);
          break;
        case 'applyVerdictThenClearBlur':
          if (!handle.suspended) this.presentation.applyVerdictOverlay(handle, true);
          break;
        case 'clearVerdict':
          this.presentation.clearVerdictOverlay(handle);
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
          this.sampler.stopTicker(handle);
          break;
        case 'resumeTicker':
          // Error-cooldown expiry: re-arm frame delivery, and if the video is
          // mid-playback there will be no fresh 'play' event — synthesize one.
          this.sampler.stopTicker(handle);
          this.sampler.startTicker(handle);
          if (!handle.suspended && !video.paused && !video.ended) {
            this.dispatch(handle, { type: 'play', at: performance.now() });
          }
          break;
        case 'startDvr':
          this.presentation.startDvr(handle);
          break;
        case 'stopDvr':
          this.presentation.stopDvr(handle);
          break;
        case 'cleanup':
          this.teardown(handle);
          break;
      }
    }
  }

  private teardown(handle: SessionHandle): void {
    const { video } = handle;
    this.sampler.teardown(handle);
    this.suspension.clearGrace(handle);
    this.presentation.stopDvr(handle);
    for (const pending of handle.timers.values()) clearTimeout(pending);
    handle.timers.clear();
    handle.removeListeners();
    this.suspension.unobserve(video);
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
}

export const videoSessions = new VideoSessionRegistry();
