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
  applyBlacklistStyling,
  clearProcessedStatus,
  PROCESSED_ATTR_MAP,
  resetImageStyling,
  type ProcessedStatus,
} from '@/entrypoints/content/presentation/initialStyling';
import { registerQuickToggle, unregisterQuickToggle } from '@/entrypoints/content/presentation/quickToggle';
import { videoMaskOverlays } from '@/entrypoints/content/presentation/videoMaskOverlay';
import { hasMuteIntent, releaseMuteHold, releaseRelayAudio } from '@/entrypoints/content/video/dvr/relayAudio';
import { VerdictTimeline } from '@/entrypoints/content/video/dvr/verdictTimeline';
import { releaseCorsVideoCache } from '@/entrypoints/content/video/sampling/capture';
import { FrameSampler } from '@/entrypoints/content/video/session/frameSampler';
import {
  createVideoSession,
  reduce,
  type SessionEffect,
  type SessionEvent,
  type SessionStatus,
  type VideoSessionState,
} from '@/entrypoints/content/video/session/machine';
import { SESSION_ID_ATTR, SESSION_SRC_ATTR } from '@/entrypoints/content/video/session/markers';
import {
  applyWholeBlur,
  clearWholeBlur,
  PresentationAdapter,
} from '@/entrypoints/content/video/session/presentationAdapter';
import { isVideoNearViewport, ViewportSuspension } from '@/entrypoints/content/video/session/viewportSuspension';
import { logger } from '@/utils/logger';
import { generateNonce } from '@/utils/nonce';

import type { SessionHandle } from '@/entrypoints/content/video/session/handle';
import type { FrameInferenceResult, ForcedVisibility, IFramePrediction, IHostSettings } from '@/utils/types';

const log = logger.withTag('videoSession:registry');

const STATUS_TO_PROCESSED: Record<SessionStatus, ProcessedStatus> = {
  safe: 'safe',
  unsafe: 'unsafe',
  skipped: 'skipped',
};

let warnedTimestamplessPrediction = false;

interface PendingAttachment {
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

/**
 * A user's forced visibility for one (element × source) pair. Session-scoped by
 * design: nothing is persisted, and a changed source drops the override — a
 * different video deserves a fresh verdict.
 */
interface ForcedEntry {
  srcObject: HTMLVideoElement['srcObject'];
  url: string;
  state: Exclude<ForcedVisibility, 'auto'>;
  unprocessed: boolean;
}

function matchesForcedSource(entry: ForcedEntry, source: ResolvedVideoSource): boolean {
  return source.srcObject ? entry.srcObject === source.srcObject : entry.srcObject === null && entry.url === source.url;
}

class VideoSessionRegistry {
  private readonly byId = new Map<string, SessionHandle>();
  private readonly byVideo = new WeakMap<HTMLVideoElement, SessionHandle>();
  /** Videos awaiting a resolved source; strong so disposeAll/sweep can cancel the waits. */
  private readonly pendingByVideo = new Map<HTMLVideoElement, PendingAttachment>();
  /** Quick-toggle overrides; consulted at attachment so a forced video never gets a session. */
  private readonly forcedByVideo = new WeakMap<HTMLVideoElement, ForcedEntry>();
  /** Teardown for live forced presentations (no session exists); strong so disposeAll/sweep reach them. */
  private readonly forcedActive = new Map<HTMLVideoElement, () => void>();
  /** Last attachment settings, so a toggle on a session-less forced video can re-attach. */
  private readonly settingsByVideo = new WeakMap<HTMLVideoElement, IHostSettings>();

  // Every port forwards through an arrow so the modules resolve each other at
  // call time, not at field-initialization time: the wiring stays correct
  // however these three fields are ordered.
  private readonly presentation = new PresentationAdapter({
    dispatch: (handle, event) => this.dispatch(handle, event),
    // Latched per DVR run (set at startDvr); the adaptive estimate only seeds
    // runs that derive it fresh.
    currentDelaySec: handle => handle.dvrRun?.delaySec ?? this.sampler.currentDvrDelaySec(handle),
  });

  private readonly sampler = new FrameSampler({
    dispatch: (handle, event) => this.dispatch(handle, event),
    captureIntoRing: (handle, mediaTime) => this.presentation.captureIntoRing(handle, mediaTime),
  });

  private readonly suspension = new ViewportSuspension({
    handleFor: video => this.byVideo.get(video),
    dispatch: (handle, event) => this.dispatch(handle, event),
    sampler: {
      startTicker: handle => this.sampler.startTicker(handle),
      stopTicker: handle => this.sampler.stopTicker(handle),
      invalidateForSuspend: handle => this.sampler.invalidateForSuspend(handle),
      replayDeferredThumbnail: handle => this.sampler.replayDeferredThumbnail(handle),
      consumePendingResample: handle => this.sampler.consumePendingResample(handle),
      discardPendingResample: handle => this.sampler.discardPendingResample(handle),
    },
    reapplyStaticMask: handle => {
      applyWholeBlur(handle.video, handle.hostSettings);
      this.presentation.applyVerdictOverlay(handle, true);
    },
  });

  /**
   * Attach a video, creating its VideoSession. A video without a resolved
   * source yet is attached as soon as resource selection yields one.
   * Re-attaching the same (element, source) pair only refreshes host settings;
   * a changed source disposes the old session and starts a fresh one.
   */
  attach(video: HTMLVideoElement, hostSettings: IHostSettings): void {
    this.sweepDisconnected();
    this.settingsByVideo.set(video, hostSettings);
    const source = resolveVideoSource(video);
    if (!source) {
      this.awaitResolvedSource(video, hostSettings);
      return;
    }
    this.pendingByVideo.get(video)?.cancel();

    const forced = this.forcedByVideo.get(video);
    if (forced) {
      if (matchesForcedSource(forced, source)) {
        this.applyForcedPresentation(video, hostSettings, forced);
        return;
      }
      this.forcedByVideo.delete(video);
      this.forcedActive.get(video)?.();
    }

    const existing = this.byVideo.get(video);
    if (existing) {
      if (isSameVideoSource(existing, source) && existing.state.phase !== 'disposed') {
        existing.hostSettings = hostSettings;
        return;
      }
      this.dispose(video);
    }

    const sessionId = generateNonce();
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
      dvrRun: null,
      timeline: new VerdictTimeline(),
      dvrStallFloorSec: 0,
      dvrEncodedIneligible: false,
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
    video.setAttribute(SESSION_SRC_ATTR, handle.src);
    video.setAttribute(SESSION_ID_ATTR, handle.sessionId);
    this.registerToggle(video, hostSettings, 'auto', false);

    const born = createVideoSession();
    handle.state = born.state;
    this.execute(handle, born.effects);

    // Undelayable audio is not an attachment gate (ADR 0001): the machine's
    // audioRoute policy decides engage/retry/withdraw from engage results
    // and raw mute intent (ADR 0002).
    this.bindMediaEvents(handle);
    this.suspension.observe(handle);
    if (!handle.suspended) this.sampler.startTicker(handle);
    this.sampler.queueThumbnailSourceReady(handle);
  }

  /** Route a batch of frame inference results to their sessions; unknown sessions are dropped. */
  handleResults(results: FrameInferenceResult[]): void {
    this.sweepDisconnected();
    for (const result of results) {
      if (result.status === 'error') {
        const handle = this.byId.get(result.sessionId);
        if (!handle) continue;
        // The attempt is finalized with no verdict — same stance as a capture
        // failure: free the in-flight slot now instead of waiting out the
        // sample timeout, and let the error streak decide on a cooldown.
        this.dispatch(handle, {
          type: 'sendFailed',
          frameIndex: result.frameIndex,
          at: performance.now(),
        });
        continue;
      }
      const pred = result.prediction;
      const handle = this.byId.get(pred.sessionId);
      if (!handle) {
        log.debug('Dropping prediction for unknown session:', pred.sessionId);
        continue;
      }
      // A playback frame without a timeline position means the background is
      // running a different build than this content script (a stale dev
      // service worker after a failed extension reload). The VerdictTimeline can
      // never match such verdicts to frames, so the DVR stays fail-closed —
      // surface the skew instead of blurring silently forever.
      if (pred.frameIndex >= 0 && typeof pred.timestampSec !== 'number' && !warnedTimestamplessPrediction) {
        warnedTimestamplessPrediction = true;
        log.error(
          'Frame prediction arrived without timestampSec — background and content script are from different builds. Reload the extension.',
        );
      }
      handle.lastPrediction = pred;
      const unsafe = Boolean(pred.predictions?.length);
      const settled = this.sampler.recordVerdictLatency(handle, pred.frameIndex);
      this.dispatchPrediction(handle, pred, {
        type: 'predictionReceived',
        frameIndex: pred.frameIndex,
        unsafe,
        at: performance.now(),
      });
      this.presentation.recordVerdict(handle, pred, unsafe);
      if (settled) {
        // After the verdict lands in the timeline: the coverage it just added
        // decides whether the latched delay is still large enough.
        this.presentation.syncDvrVerdict(handle);
      }
    }
  }

  /** Dispose the session bound to this element (source change or removal). */
  dispose(video: HTMLVideoElement): void {
    // Presentation dies here, but the forcedByVideo override survives on
    // purpose: it is keyed per (element × source), so re-attaching the same
    // pair re-enters the forced presentation; a changed source drops it.
    this.forcedActive.get(video)?.();
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
    for (const cleanup of [...this.forcedActive.values()]) {
      cleanup();
    }
    for (const [video, pending] of [...this.pendingByVideo]) {
      pending.cancel();
      clearWholeBlur(video);
    }
    for (const handle of this.byId.values()) {
      this.dispatch(handle, { type: 'dispose' });
    }
  }

  /**
   * Quick-toggle entry point: 'visible' and 'blocked' replace the session with
   * a static presentation (no sampling, no DVR, no audio delay); 'auto' drops
   * the override and re-attaches for a fresh verdict. State is per
   * (element × source) and dies with the source — nothing is persisted.
   */
  setForcedVisibility(video: HTMLVideoElement, next: ForcedVisibility): void {
    const settings = this.byVideo.get(video)?.hostSettings ?? this.settingsByVideo.get(video);
    if (!settings) return;

    if (next === 'auto') {
      this.forcedByVideo.delete(video);
      this.forcedActive.get(video)?.();
      this.dispose(video);
      this.attach(video, settings);
      return;
    }

    const source = resolveVideoSource(video);
    if (!source) return;
    const unprocessed = this.forcedByVideo.get(video)?.unprocessed ?? video.hasAttribute(PROCESSED_ATTR_MAP.skipped);
    this.forcedByVideo.set(video, { srcObject: source.srcObject, url: source.url, state: next, unprocessed });
    this.attach(video, settings);
  }

  /**
   * The extension goes hands-off ('visible') or applies the blacklist-style
   * mask ('blocked') with no VideoSession behind it. A source-change listener
   * is the only machinery left running: the override describes this source
   * only, so a new source re-enters normal attachment.
   */
  private applyForcedPresentation(video: HTMLVideoElement, hostSettings: IHostSettings, entry: ForcedEntry): void {
    const existing = this.byVideo.get(video);
    if (existing) this.dispatch(existing, { type: 'dispose' });
    this.forcedActive.get(video)?.();

    clearWholeBlur(video);
    resetImageStyling(video);
    if (entry.state === 'blocked') {
      applyBlacklistStyling(video, hostSettings);
      video.setAttribute(PROCESSED_ATTR_MAP.unsafe, '');
    } else {
      video.setAttribute(PROCESSED_ATTR_MAP.skipped, '');
    }
    this.registerToggle(video, hostSettings, entry.state, entry.state === 'blocked', entry.unprocessed);

    const onSourceChanged = () => {
      const current = resolveVideoSource(video);
      // A same-source reload passes through a transient no-source moment
      // ('emptied' before re-selection). Not a source change yet: keep the
      // override and let the loadstart that resolves a source decide.
      if (!current) return;
      const forced = this.forcedByVideo.get(video);
      if (forced && matchesForcedSource(forced, current)) return;
      this.forcedByVideo.delete(video);
      this.forcedActive.get(video)?.();
      this.attach(video, hostSettings);
    };
    video.addEventListener('loadstart', onSourceChanged);
    video.addEventListener('emptied', onSourceChanged);
    this.forcedActive.set(video, () => {
      this.forcedActive.delete(video);
      video.removeEventListener('loadstart', onSourceChanged);
      video.removeEventListener('emptied', onSourceChanged);
      unregisterQuickToggle(video);
      resetImageStyling(video);
    });
  }

  private registerToggle(
    video: HTMLVideoElement,
    hostSettings: IHostSettings,
    forcedVisibility: ForcedVisibility,
    hasDetections: boolean,
    unprocessed = false,
  ): void {
    registerQuickToggle(video, {
      src: this.byVideo.get(video)?.src ?? resolveVideoSource(video)?.url ?? '',
      forcedVisibility,
      hasDetections,
      unprocessed,
      hostSettings,
      onToggle: next => this.setForcedVisibility(video, next),
    });
  }

  /**
   * A video with no resolved source yet (<source> children still selecting,
   * MSE, late src assignment) is attached when resource selection yields one:
   * 'loadstart' fires whenever selection begins — even with preload="none".
   * Object-backed media is attached as soon as `srcObject` becomes available,
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
    // Attachment re-applies the blur (idempotent); it never lifts here, so the
    // wait→ATTACHED handoff has no unprotected gap.
    applyWholeBlur(video, hostSettings);
    const entry: PendingAttachment = { hostSettings, cancel: () => {} };
    const onLoadstart = () => {
      if (!resolveVideoSource(video)) return;
      entry.cancel();
      this.attach(video, entry.hostSettings);
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
    for (const [video, cleanup] of [...this.forcedActive]) {
      if (!video.isConnected) {
        cleanup();
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
          // Safe↔unsafe flips move the button between the two host switches;
          // 'skipped' (never analyzed) surfaces as the inverted (white) button.
          this.registerToggle(
            video,
            handle.hostSettings,
            'auto',
            effect.status === 'unsafe',
            effect.status === 'skipped',
          );
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
        case 'drainDvr':
          this.presentation.drainDvr(handle);
          break;
        case 'engageAudioRoute':
          this.presentation.engageAudioRoute(handle);
          break;
        case 'releaseAudioRoute':
          this.presentation.releaseAudioRoute(handle);
          break;
        case 'holdPageMute':
          this.presentation.holdPageMute(handle);
          break;
        case 'releaseMuteHold':
          this.presentation.releaseMuteHold(handle);
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
    releaseRelayAudio(video);
    releaseMuteHold(video);
    releaseCorsVideoCache(video);
    unregisterQuickToggle(video);
    video.removeAttribute(SESSION_SRC_ATTR);
    video.removeAttribute(SESSION_ID_ATTR);
    this.byId.delete(handle.sessionId);
    if (this.byVideo.get(video) === handle) {
      this.byVideo.delete(video);
    }
  }

  /** Media events feed the machine; a source change re-attaches under the stored settings. */
  private bindMediaEvents(handle: SessionHandle): void {
    const { video } = handle;
    const now = () => performance.now();

    const onPlay = () => {
      if (!handle.suspended) this.dispatch(handle, { type: 'play', at: now() });
    };
    const onPause = () => this.dispatch(handle, { type: 'pause', at: now(), atEnd: video.ended });
    const onEnded = () => this.dispatch(handle, { type: 'ended', at: now() });
    const onSeeked = () => this.dispatch(handle, { type: 'seeked', at: now(), timestampSec: video.currentTime });
    // Raw site intent for the machine's audio-route policy (ADR 0002). While
    // the relay module owns the element's audio output (hold or engaged
    // relay), its intent tracker forwards site changes instead — the module's
    // own writes must not read as intent.
    const onVolumeChange = () => {
      if (hasMuteIntent(video)) return;
      const audible = !video.muted && video.volume > 0;
      this.dispatch(handle, { type: audible ? 'unmuted' : 'muted', at: now() });
    };
    const onSourceChanged = () => {
      const current = resolveVideoSource(video);
      if (current && isSameVideoSource(handle, current)) return;
      // New or removed source on the same element: the old VideoSession (and
      // its blur, overlays, and status) dies with the content it described. A
      // new session is born now, or once the next source resolves. 'emptied'
      // matters because removeAttribute('src') + load() never fires loadstart.
      const settings = handle.hostSettings;
      this.dispose(video);
      this.attach(video, settings);
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('loadstart', onSourceChanged);
    video.addEventListener('emptied', onSourceChanged);

    handle.removeListeners = () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('loadstart', onSourceChanged);
      video.removeEventListener('emptied', onSourceChanged);
    };

    if (!video.muted && video.volume > 0) {
      this.dispatch(handle, { type: 'unmuted', at: now() });
    }
    // A video already playing at attachment goes straight to sampling.
    if (!video.paused && !video.ended) {
      onPlay();
    }
  }
}

export const videoSessions = new VideoSessionRegistry();
