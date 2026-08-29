/**
 * Presentation side of a VideoSession (docs/VIDEO_PROCESSING.md): whole-video
 * blur, precise mask overlays serialized per session, and the DVR runtime
 * (frame ring, verdict track, delayed player, audio delay). Executes the
 * machine's presentation effects: it reads session state only to drop work the
 * machine has already superseded (disposal, a DVR that took over the element),
 * never to decide what to present.
 */

import { BLUR_CLASS } from '@/entrypoints/content/presentation/constants';
import { VideoDvrPlayer } from '@/entrypoints/content/presentation/videoDvrPlayer';
import { videoMaskOverlays } from '@/entrypoints/content/presentation/videoMaskOverlay';
import { engageAudioDelay, releaseAudioDelay, updateAudioDelay } from '@/entrypoints/content/video/dvr/audioDelay';
import { dvrCaptureScale } from '@/entrypoints/content/video/dvr/captureScale';
import { startDvrCaptureTap } from '@/entrypoints/content/video/dvr/captureTap';
import {
  deriveDvrDelayMs,
  isAnalysisUnderrun,
  MAX_DVR_DELAY_MS,
  UNDERRUN_VERDICT_STREAK,
} from '@/entrypoints/content/video/dvr/delay';
import { encodedBitrate } from '@/entrypoints/content/video/dvr/encodedFrameRing';
import { createDvrFrameStore } from '@/entrypoints/content/video/dvr/frameStoreFactory';
import {
  drainRelayAudio,
  engageRelayAudio,
  holdPageMute,
  releaseMuteHold,
  releaseRelayAudio,
} from '@/entrypoints/content/video/dvr/relayAudio';
import { dvrRingBudget, type RingQuality } from '@/entrypoints/content/video/dvr/ringBudget';
import { type AudioEngageOutcome, type SessionEvent } from '@/entrypoints/content/video/session/machine';
import { logger } from '@/utils/logger';
import { buildMaskingFilter } from '@/utils/masking';

import type { SessionHandle } from '@/entrypoints/content/video/session/handle';
import type { IFramePrediction, IHostSettings, IImagePrediction } from '@/utils/types';

const log = logger.withTag('videoSession:presentation');

/** Ring horizon: the adaptive delay's ceiling plus slack, so a growing D still finds frames. */
const DVR_BUFFER_HORIZON_SEC = MAX_DVR_DELAY_MS / 1000 + 1;
/** Projection cap when neither display nor native size is known yet: assume 1080p rather than under-budget. */
const FALLBACK_CAPTURE_CAP_PX = 1920;
/** Re-register only on a material display resize (embedded → fullscreen), not layout jitter. */
const CAP_REREGISTER_RATIO = 1.25;
/** Per-verdict D growth when the store reports a decode stall (covered miss). */
const DECODE_STALL_DELAY_STEP_SEC = 0.25;
/** A tap can stall silently (muted cross-origin track); rVFC captures resume past this window. */
const TAP_LIVENESS_WINDOW_SEC = 0.5;

/**
 * Finite capture-width cap: rendered width in device pixels, up to native. The
 * budget ladder's full tier has no ceiling of its own, so this is the number
 * that bounds both the capture and its projection in the shared budget.
 */
function captureWidthCap(video: HTMLVideoElement, nativeWidth: number): number {
  const displayWidth = Math.round(video.clientWidth * (globalThis.devicePixelRatio || 1));
  if (displayWidth > 0 && nativeWidth > 0) return Math.min(displayWidth, nativeWidth);
  return displayWidth || nativeWidth || FALLBACK_CAPTURE_CAP_PX;
}

function capChangedMaterially(nextCap: number, registeredCap: number): boolean {
  const [smaller, larger] = nextCap < registeredCap ? [nextCap, registeredCap] : [registeredCap, nextCap];
  return smaller <= 0 || larger / smaller >= CAP_REREGISTER_RATIO;
}

/**
 * Whole-video blur is applied inline: the BLUR_CLASS stylesheet lives in the
 * document and does not reach videos inside shadow roots. The class stays on
 * as the state marker.
 */
export function applyWholeBlur(video: HTMLVideoElement, hostSettings: IHostSettings): void {
  if (!video.classList.contains(BLUR_CLASS) && video.style.filter) {
    video.dataset.hbOriginalFilter = video.style.filter;
  }
  video.classList.add(BLUR_CLASS);
  video.style.setProperty('filter', buildMaskingFilter(hostSettings.masking), 'important');
}

export function clearWholeBlur(video: HTMLVideoElement): void {
  video.classList.remove(BLUR_CLASS);
  const original = video.dataset.hbOriginalFilter;
  delete video.dataset.hbOriginalFilter;
  if (original) {
    video.style.setProperty('filter', original);
  } else {
    video.style.removeProperty('filter');
  }
}

export interface PresentationPorts {
  dispatch(handle: SessionHandle, event: SessionEvent): void;
  /** The adaptive presentation delay D, in seconds; the sampler owns the latencies behind it. */
  currentDelaySec(handle: SessionHandle): number;
}

export class PresentationAdapter {
  constructor(private readonly ports: PresentationPorts) {}

  startDvr(handle: SessionHandle): void {
    if (handle.dvr) return;
    // D is derived once per DVR run — at start and at every seek/loop restart
    // (the machine re-warms through stopDvr/startDvr there) — then latched, so
    // presentation never jumps mid-run. A range the timeline already covers
    // needs no inference wait and gets a small D: the warm-up pause all but
    // disappears on replays and re-visited seeks.
    // Floored by the stall floor: a store that already proved it needs a
    // larger D must not re-limp through the same raises after every re-warm.
    handle.dvrDelaySec = Math.max(
      deriveDvrDelayMs(handle.latenciesMs, handle.timeline.coverageAheadOf(handle.video.currentTime)) / 1000,
      handle.dvrStallFloorSec,
    );
    // Claim capacity in the shared budget; every DVR exit funnels through
    // stopDvr, so suspension and disposal both return it.
    const registeredWidth = handle.video.videoWidth;
    const registeredHeight = handle.video.videoHeight;
    this.registerDemand(handle, registeredWidth, registeredHeight);
    const quality = dvrRingBudget.quality();
    const store = createDvrFrameStore({
      maxDurationSec: this.ringHorizonSec(handle, quality),
      maxBytes: dvrRingBudget.sessionMaxBytes(),
      probeWidth: registeredWidth || FALLBACK_CAPTURE_CAP_PX,
      probeHeight: registeredHeight || Math.round((FALLBACK_CAPTURE_CAP_PX * 9) / 16),
      encodedIneligible: handle.dvrEncodedIneligible,
      onEncodedError: () => {
        handle.dvrEncodedIneligible = true;
      },
      // Fires on the async raw → encoded upgrade and on the error fallback:
      // the debug attribute (e2e asserts which path ran) and the budget's
      // demand model both follow the backing implementation.
      onKindChange: kind => {
        if (handle.dvr?.store !== store) return;
        handle.video.dataset.hbDvrStore = kind;
        this.registerDemand(handle, handle.dvr.registeredWidth, handle.dvr.registeredHeight);
      },
    });
    handle.video.dataset.hbDvrStore = store.kind();
    const player = new VideoDvrPlayer({
      video: handle.video,
      store,
      timeline: handle.timeline,
      getDelaySec: () => this.ports.currentDelaySec(handle),
      getMasking: () => handle.hostSettings.masking,
      onReady: () => {
        this.ports.dispatch(handle, { type: 'bufferReady', at: performance.now() });
      },
    });
    const dvr: NonNullable<SessionHandle['dvr']> = {
      store,
      player,
      lastCapturedMediaTime: Number.NEGATIVE_INFINITY,
      captureTap: null,
      lastTapMediaTime: Number.NEGATIVE_INFINITY,
      captureSurface: null,
      registeredWidth,
      registeredHeight,
      registeredCaptureCap: captureWidthCap(handle.video, registeredWidth),
      lastCoveredMisses: 0,
      // Warm-up priming misses are not a stall; counting them would ratchet D
      // on every re-warm.
      stallHoldoff: true,
      underrunStreak: 0,
    };
    handle.dvr = dvr;
    dvr.captureTap = startDvrCaptureTap(handle.video, (frame, mediaTime) => {
      // The tap can outlive its run by a frame or two (async reader); a stale
      // delivery must not feed a newer run's ring.
      if (handle.dvr !== dvr) {
        frame.close();
        return;
      }
      dvr.lastTapMediaTime = mediaTime;
      this.capture(handle, frame, mediaTime);
    });
  }

  /**
   * One engage attempt: delay line first, relay element when the line is
   * permanently unavailable. The outcome goes back to the machine as an
   * audioEngageResult event; the reducer alone decides engaged/retry/withdraw.
   */
  engageAudioRoute(handle: SessionHandle): void {
    const { player } = handle.dvr ?? {};
    if (!player) return;
    // Route state, not just player identity: a pause released the route but
    // kept the player — a late engage must not land audio over a frozen canvas.
    const stillWanted = () => handle.dvr?.player === player && handle.state.audioRoute === 'pending';
    const report = (result: AudioEngageOutcome) =>
      this.ports.dispatch(handle, { type: 'audioEngageResult', result, at: performance.now() });
    void engageAudioDelay(handle.video, this.ports.currentDelaySec(handle), stillWanted)
      .then(async result => {
        if (!stillWanted()) return;
        if (result === 'engaged') return report('delayLine');
        if (result === 'deferred') return report('deferred');
        const relay = await engageRelayAudio(
          handle.video,
          () => this.ports.currentDelaySec(handle),
          audible => this.reportSiteAudible(handle, audible),
        );
        if (!stillWanted()) {
          releaseRelayAudio(handle.video);
          return;
        }
        const outcomeByRelay: Record<typeof relay, AudioEngageOutcome> = {
          engaged: 'relay',
          transient: 'deferred',
          terminal: 'unavailable',
        };
        report(outcomeByRelay[relay]);
      })
      .catch((error: unknown) => log.debug('Audio route engage failed:', error));
  }

  /** Drop whatever delayed route is up; the site's audio intent is restored. */
  releaseAudioRoute(handle: SessionHandle): void {
    releaseAudioDelay(handle.video);
    releaseRelayAudio(handle.video);
    releaseMuteHold(handle.video);
  }

  /** Bounded silence while a route is pending. */
  holdPageMute(handle: SessionHandle): void {
    holdPageMute(handle.video, audible => this.reportSiteAudible(handle, audible));
  }

  releaseMuteHold(handle: SessionHandle): void {
    releaseMuteHold(handle.video);
  }

  private reportSiteAudible(handle: SessionHandle, audible: boolean): void {
    this.ports.dispatch(handle, { type: audible ? 'unmuted' : 'muted', at: performance.now() });
  }

  private registerDemand(handle: SessionHandle, nativeWidth: number, nativeHeight: number): void {
    // An encoded session's demand is bitrate-shaped, not RGBA-shaped: it
    // barely registers on the ladder, so it never degrades raw sessions.
    const encoded = handle.dvr?.store.kind() === 'encoded';
    const bitrateWidth = nativeWidth || FALLBACK_CAPTURE_CAP_PX;
    const bitrateHeight = nativeHeight || Math.round((FALLBACK_CAPTURE_CAP_PX * 9) / 16);
    dvrRingBudget.register(handle.sessionId, {
      nativeWidth,
      nativeHeight,
      captureMaxWidth: captureWidthCap(handle.video, nativeWidth),
      horizonSec: DVR_BUFFER_HORIZON_SEC,
      minHorizonSec: (handle.dvrDelaySec ?? this.ports.currentDelaySec(handle)) + 1,
      ...(encoded ? { encodedBytesPerSec: encodedBitrate(bitrateWidth, bitrateHeight) / 8 } : {}),
    });
  }

  stopDvr(handle: SessionHandle): void {
    const { dvr } = handle;
    if (!dvr) return;
    handle.dvr = null;
    handle.dvrDelaySec = null;
    dvr.captureTap?.stop();
    dvrRingBudget.release(handle.sessionId);
    this.releaseAudioRoute(handle);
    dvr.player.destroy();
    dvr.store.release();
    delete handle.video.dataset.hbDvrStore;
  }

  /** Never shrink a live ring below the latched D: presentation would strand on the warm-up frame. */
  private ringHorizonSec(handle: SessionHandle, quality: RingQuality): number {
    const delaySec = handle.dvrDelaySec ?? this.ports.currentDelaySec(handle);
    return Math.max(delaySec + 1, DVR_BUFFER_HORIZON_SEC * quality.horizonScale);
  }

  /** Playback ended: the presenter consumes the ring tail in real time, then holds the final frame. */
  drainDvr(handle: SessionHandle): void {
    handle.dvr?.player.startDrain();
    drainRelayAudio(handle.video);
  }

  /** Keep the audio delay tracking the presentation delay (engage retries are machine-driven). */
  syncAudioDelay(handle: SessionHandle): void {
    if (!handle.dvr) return;
    // Relay Audio reads the delay via callback; only the WebAudio line needs a ramp.
    updateAudioDelay(handle.video, this.ports.currentDelaySec(handle));
  }

  /**
   * D is latched per DVR run so presentation never jumps mid-run — but a run
   * that latched too small a D (no observed round-trips yet at the first play,
   * or a covered range whose coverage ran out) would present verdict-less
   * frames, and therefore whole-blur, for the rest of the run. Let D grow, and
   * only grow: presentation slides further behind the live edge — repeating a
   * moment of already-seen video, within the ring's horizon — instead of
   * jumping forward into content no verdict describes. A genuinely covered
   * range still derives the small covered D, so this leaves it alone.
   */
  raiseDelayIfLagging(handle: SessionHandle): void {
    const { dvr } = handle;
    if (!dvr || handle.dvrDelaySec === null) return;
    const coverageAheadSec = handle.timeline.coverageAheadOf(handle.video.currentTime);
    const derivedSec = deriveDvrDelayMs(handle.latenciesMs, coverageAheadSec) / 1000;
    // A decode stall (covered miss since the last sync) feeds the same
    // let-D-grow path: the slow decoder buys itself headroom by sliding
    // further behind the live edge, bounded per verdict and by the ceiling
    // the ring horizon is sized for. A raise itself moves the target backward,
    // forcing a decoder re-warm whose misses would read as a fresh stall and
    // ratchet D to the ceiling — so the sync after any raise swallows its miss
    // delta; a genuine sustained stall re-raises on the sync after that.
    const misses = dvr.store.coveredMisses();
    const missDelta = misses > dvr.lastCoveredMisses;
    const stalled = missDelta && !dvr.stallHoldoff;
    dvr.lastCoveredMisses = misses;
    // Consume the holdoff only when it swallowed a delta, or a sync landing
    // before the warm-up misses would burn it early.
    if (missDelta) dvr.stallHoldoff = false;
    // Raise by the measured capture→presentable lag when it beats the fixed
    // step: a pipeline running ~a second behind escapes in one raise.
    const newestSec = dvr.store.newestTime();
    const pipelineLagSec = newestSec === null ? 0 : handle.video.currentTime - newestSec;
    const stallTargetSec = stalled
      ? Math.min(
          MAX_DVR_DELAY_MS / 1000,
          Math.max(handle.dvrDelaySec + DECODE_STALL_DELAY_STEP_SEC, pipelineLagSec + DECODE_STALL_DELAY_STEP_SEC),
        )
      : 0;
    const targetSec = Math.max(derivedSec, stallTargetSec);
    if (targetSec > handle.dvrDelaySec) {
      handle.dvrDelaySec = targetSec;
      // Only stall-driven growth persists: latency-derived growth re-derives
      // correctly at the next startDvr.
      if (stallTargetSec >= targetSec) {
        handle.dvrStallFloorSec = Math.max(handle.dvrStallFloorSec, stallTargetSec);
      }
      dvr.stallHoldoff = true;
      this.registerDemand(handle, dvr.registeredWidth, dvr.registeredHeight);
      updateAudioDelay(handle.video, targetSec);
    }
    this.detectUnderrun(handle, coverageAheadSec);
  }

  /** Sustained "D pinned at ceiling, coverage trailing" becomes a machine event; the machine decides the response. */
  private detectUnderrun(handle: SessionHandle, coverageAheadSec: number): void {
    const { dvr } = handle;
    if (!dvr || handle.dvrDelaySec === null) return;
    if (!isAnalysisUnderrun(handle.latenciesMs, coverageAheadSec, handle.dvrDelaySec)) {
      dvr.underrunStreak = 0;
      return;
    }
    dvr.underrunStreak++;
    if (dvr.underrunStreak < UNDERRUN_VERDICT_STREAK) return;
    // Reset so the post-relief window measures fresh verdicts before a second fire.
    dvr.underrunStreak = 0;
    this.ports.dispatch(handle, { type: 'analysisUnderrun', at: performance.now() });
  }

  /**
   * Land a verdict in the session timeline. Called after the machine dispatch:
   * the verdict may have just started the DVR (an unsafe sample on a session
   * whose DVR was off, e.g. after an error-cooldown resume), and its own entry
   * must land before the first draw. Every playback verdict is recorded — DVR or
   * not — so the timeline accumulates coverage that later derives a small D;
   * verdicts are keyed by media time, so even machine-stale (older-index) ones
   * describe their frame. The Thumbnail (frame −1) has no media time and stays
   * out.
   */
  recordVerdict(handle: SessionHandle, pred: IFramePrediction, unsafe: boolean): void {
    if (pred.frameIndex < 0) return;
    handle.timeline.add({
      timestampSec: pred.timestampSec,
      unsafe,
      predictions: pred.predictions ?? [],
      maskTransform: pred.maskTransform,
      width: pred.width,
      height: pred.height,
    });
  }

  captureIntoRing(handle: SessionHandle, mediaTime: number): void {
    const { dvr } = handle;
    if (!dvr) return;
    // Liveness is media-time distance, absolute: a seek must not strand the
    // fallback on a dead tap.
    if (dvr.captureTap && Math.abs(mediaTime - dvr.lastTapMediaTime) < TAP_LIVENESS_WINDOW_SEC) return;
    this.capture(handle, null, mediaTime);
  }

  /**
   * Feed the ring: presentation-sized for the raw ring (throttled to its
   * cadence), native-resolution VideoFrames for the encoded ring (native rate
   * from the tap). Buffering is display-only (no pixel readback), so it works
   * even for sources whose pixels inference may not read — the taint just
   * travels with the bitmap onto the presentation canvas.
   */
  private capture(handle: SessionHandle, tapFrame: VideoFrame | null, mediaTime: number): void {
    const { dvr } = handle;
    if (!dvr) {
      tapFrame?.close();
      return;
    }
    // Read the shared budget's current tier every capture: degradation and
    // recovery apply to live rings without a restart.
    const quality = dvrRingBudget.quality();
    const intervalSec =
      dvr.store.captureMode === 'video-frame' ? quality.encodedCaptureIntervalSec : quality.captureIntervalSec;
    // The equality guard matters at the native-rate interval (0): Chrome can
    // report the same currentTime for consecutive tap frames, and a duplicate
    // key would just be pushed for the store to drop again.
    if (
      mediaTime === dvr.lastCapturedMediaTime ||
      (mediaTime - dvr.lastCapturedMediaTime < intervalSec && mediaTime > dvr.lastCapturedMediaTime)
    ) {
      tapFrame?.close();
      return;
    }
    try {
      dvr.store.setLimits(this.ringHorizonSec(handle, quality), dvrRingBudget.sessionMaxBytes());
      const { video } = handle;
      const nativeWidth = video.videoWidth;
      const nativeHeight = video.videoHeight;
      if (!nativeWidth || !nativeHeight) return;
      const widthCap = captureWidthCap(video, nativeWidth);
      if (
        nativeWidth !== dvr.registeredWidth ||
        nativeHeight !== dvr.registeredHeight ||
        capChangedMaterially(widthCap, dvr.registeredCaptureCap)
      ) {
        // The DVR can start off the 'play' event, which fires before metadata:
        // the budget then holds a fallback 16:9 projection that understates a
        // portrait session by ~3x. Correct it as soon as the real geometry
        // lands. The display cap is demand too (the full tier has no ladder
        // ceiling), so a materially resized player — embedded → fullscreen —
        // also re-registers; small layout jitter stays below the hysteresis.
        dvr.registeredWidth = nativeWidth;
        dvr.registeredHeight = nativeHeight;
        dvr.registeredCaptureCap = widthCap;
        this.registerDemand(handle, nativeWidth, nativeHeight);
      }
      if (dvr.store.captureMode === 'video-frame') {
        // Encoded store: zero-copy GPU reference at native resolution — the
        // capture-scale ladder is bypassed, hardware encoding replaces it. The
        // timestamp carries the media time through encode → store → decode. A
        // tap frame is re-wrapped: its own timestamp lives in the capture
        // clock, not the media timeline.
        try {
          const frame = new VideoFrame(tapFrame ?? video, { timestamp: Math.round(mediaTime * 1_000_000) });
          dvr.lastCapturedMediaTime = mediaTime;
          dvr.store.push(frame, mediaTime);
        } catch (error) {
          // Typically SecurityError on a tainted source: VideoFrame needs
          // readable pixels, which the display-only canvas path does not.
          log.debug('VideoFrame capture failed; demoting to raw ring:', error);
          handle.dvrEncodedIneligible = true;
          dvr.store.demoteToRaw();
        }
        return;
      }
      // Downscale through a canvas, NOT createImageBitmap's resize options:
      // Firefox never implemented those, and per WebIDL silently ignores them —
      // native-resolution HD frames then blow the ring's byte budget, its span
      // never reaches the presentation delay, and the DVR warms forever.
      const scale = dvrCaptureScale({
        nativeWidth,
        nativeHeight,
        displayWidth: video.clientWidth * (globalThis.devicePixelRatio || 1),
        maxWidth: quality.maxWidth,
        delaySec: this.ports.currentDelaySec(handle),
        captureIntervalSec: quality.captureIntervalSec,
        maxBytes: dvrRingBudget.sessionMaxBytes(),
      });
      const width = Math.max(1, Math.round(nativeWidth * scale));
      const height = Math.max(1, Math.round(nativeHeight * scale));
      let surface = dvr.captureSurface;
      if (!surface || surface.width !== width || surface.height !== height) {
        surface = new OffscreenCanvas(width, height);
        dvr.captureSurface = surface;
      }
      const ctx = surface.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(tapFrame ?? video, 0, 0, width, height);
      // transferToImageBitmap needs no readback, so this works (display-only,
      // taint carried along) even for sources whose pixels we may not read.
      const bitmap = surface.transferToImageBitmap();
      dvr.lastCapturedMediaTime = mediaTime;
      dvr.store.push(bitmap, mediaTime);
    } catch (error) {
      log.debug('DVR buffer capture failed:', error);
    } finally {
      tapFrame?.close();
    }
  }

  /**
   * Serialized behind pending renders: a slow applyVerdict must never finish
   * after the clear and resurrect a mask on a clean video.
   */
  clearVerdictOverlay(handle: SessionHandle): void {
    this.queueOverlayTask(handle, () => {
      videoMaskOverlays.clearMaskOverlay(handle.video);
    });
  }

  applyVerdictOverlay(handle: SessionHandle, clearBlurOnPaint = false): void {
    // The last unsafe prediction, not the last one: a suspend-time re-mask
    // must render the mask that made the session masked, not a newer clean verdict.
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
      // wanted — a later suspend re-mask regenerates it from lastUnsafePrediction.
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
