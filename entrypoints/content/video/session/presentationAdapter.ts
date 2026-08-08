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
import { deriveDvrDelayMs, MAX_DVR_DELAY_MS } from '@/entrypoints/content/video/dvr/delay';
import { FrameRing } from '@/entrypoints/content/video/dvr/frameRing';
import { logger } from '@/utils/logger';
import { buildMaskingFilter } from '@/utils/masking';

import type { SessionHandle } from '@/entrypoints/content/video/session/handle';
import type { SessionEvent } from '@/entrypoints/content/video/session/machine';
import type { IFramePrediction, IHostSettings, IImagePrediction } from '@/utils/types';

const log = logger.withTag('videoSession:presentation');

/**
 * Buffer captures are cheaper and denser than inference samples. Targets
 * ~30 fps: slightly under 1/30 so the throttle cannot alias against a 60 Hz
 * rVFC tick grid and skip extra ticks (exact multiples float-compare short).
 */
export const DVR_CAPTURE_INTERVAL_SEC = 1 / 33;
/** Ring horizon: the adaptive delay's ceiling plus slack, so a growing D still finds frames. */
const DVR_BUFFER_HORIZON_SEC = MAX_DVR_DELAY_MS / 1000 + 1;
/** Per-session byte cap (~4.5 s of 640×360 RGBA at 30 fps ≈ 125 MB); only while masked. */
const DVR_BUFFER_MAX_BYTES = 128 * 1024 * 1024;

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
    handle.dvrDelaySec =
      deriveDvrDelayMs(handle.latenciesMs, handle.timeline.coverageAheadOf(handle.video.currentTime)) / 1000;
    const ring = new FrameRing(DVR_BUFFER_HORIZON_SEC, DVR_BUFFER_MAX_BYTES);
    const player = new VideoDvrPlayer({
      video: handle.video,
      ring,
      timeline: handle.timeline,
      getDelaySec: () => this.ports.currentDelaySec(handle),
      getMasking: () => handle.hostSettings.masking,
      onReady: () => {
        this.ports.dispatch(handle, { type: 'bufferReady', at: performance.now() });
        // The canvas now presents D behind the live edge; delay audio to match.
        // A permanent engage failure (the site captured the element) withdraws
        // protection entirely (ADR 0001); a deferred one retries next engage.
        void engageAudioDelay(handle.video, this.ports.currentDelaySec(handle), () => handle.dvr?.player === player)
          .then(result => {
            if (result === 'unavailable') {
              this.ports.dispatch(handle, { type: 'audioUndelayable', at: performance.now() });
            }
          })
          .catch((error: unknown) => log.debug('Audio delay engage failed:', error));
      },
    });
    handle.dvr = {
      ring,
      player,
      lastCapturedMediaTime: Number.NEGATIVE_INFINITY,
      captureSurface: null,
    };
  }

  stopDvr(handle: SessionHandle): void {
    const { dvr } = handle;
    if (!dvr) return;
    handle.dvr = null;
    handle.dvrDelaySec = null;
    releaseAudioDelay(handle.video);
    dvr.player.destroy();
    dvr.ring.release();
  }

  /** Playback ended: the presenter consumes the ring tail in real time, then holds the final frame. */
  drainDvr(handle: SessionHandle): void {
    handle.dvr?.player.startDrain();
  }

  /** Keep the audio delay tracking the presentation delay. */
  syncAudioDelay(handle: SessionHandle): void {
    if (handle.dvr) updateAudioDelay(handle.video, this.ports.currentDelaySec(handle));
  }

  /**
   * Land a verdict in the session timeline. Called after the machine dispatch:
   * an unsafe verdict may have just started the DVR, and its own entry must
   * land before the first draw. Every playback verdict is recorded — DVR or
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

  /**
   * Feed the ring while the DVR is active: presentation-sized, throttled below
   * the tick rate. Buffering is display-only (no pixel readback), so it works
   * even for sources whose pixels inference may not read — the taint just
   * travels with the bitmap onto the presentation canvas.
   */
  captureIntoRing(handle: SessionHandle, mediaTime: number): void {
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
      const scale = dvrCaptureScale({
        nativeWidth,
        nativeHeight,
        displayWidth: video.clientWidth * (globalThis.devicePixelRatio || 1),
        delaySec: this.ports.currentDelaySec(handle),
        captureIntervalSec: DVR_CAPTURE_INTERVAL_SEC,
        maxBytes: DVR_BUFFER_MAX_BYTES,
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
