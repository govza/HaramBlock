/**
 * Presentation side of a VideoSession (docs/VIDEO_PROCESSING.md): whole-video
 * blur, precise mask overlays serialized per session, the audio route
 * execution, and the DVR run lifecycle (the run itself lives in dvr/run.ts).
 * Executes the machine's presentation effects: it reads session state only to
 * drop work the machine has already superseded (disposal, a DVR that took over
 * the element), never to decide what to present.
 */

import { BLUR_CLASS } from '@/entrypoints/content/presentation/constants';
import { videoMaskOverlays } from '@/entrypoints/content/presentation/videoMaskOverlay';
import { engageAudioDelay, releaseAudioDelay, updateAudioDelay } from '@/entrypoints/content/video/dvr/audioDelay';
import {
  drainRelayAudio,
  engageRelayAudio,
  holdPageMute,
  releaseMuteHold,
  releaseRelayAudio,
} from '@/entrypoints/content/video/dvr/relayAudio';
import { defaultDvrRunPorts, startDvrRun } from '@/entrypoints/content/video/dvr/run';
import { type AudioEngageOutcome, type SessionEvent } from '@/entrypoints/content/video/session/machine';
import { buildMaskingFilter } from '@/utils/masking';
import { ATTR, getLogger, getTracer } from '@/utils/telemetry';
import { SPAN, umbrellaContext } from '@/utils/telemetry/roundtrip';

import type { SessionHandle } from '@/entrypoints/content/video/session/handle';
import type { IFramePrediction, IHostSettings, IImagePrediction } from '@/utils/types';

const log = getLogger('videoSession:presentation');
const tracer = getTracer('video');

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
    if (handle.dvrRun) return;
    handle.dvrWarmupSpan = tracer.startSpan(
      SPAN.dvrWarmup,
      { attributes: { [ATTR.sessionId]: handle.sessionId, [ATTR.hostname]: handle.hostSettings.hostname } },
      umbrellaContext(handle.trace),
    );
    handle.dvrRun = startDvrRun(
      defaultDvrRunPorts({
        video: handle.video,
        getMasking: () => handle.hostSettings.masking,
        events: event => {
          if (event.type === 'bufferReady') this.endWarmup(handle, 'ready');
          this.ports.dispatch(handle, event);
        },
        onDelayChanged: delaySec => updateAudioDelay(handle.video, delaySec),
      }),
      {
        sessionId: handle.sessionId,
        timeline: handle.timeline,
        latenciesMs: handle.latenciesMs,
        stallFloorSec: handle.dvrStallFloorSec,
        encodedIneligible: handle.dvrEncodedIneligible,
      },
    );
  }

  stopDvr(handle: SessionHandle, reason: string): void {
    const run = handle.dvrRun;
    if (!run) return;
    handle.dvrRun = null;
    this.endWarmup(handle, 'aborted');
    this.releaseAudioRoute(handle);
    const carry = run.stop(reason);
    handle.dvrStallFloorSec = carry.stallFloorSec;
    handle.dvrEncodedIneligible = carry.encodedIneligible;
  }

  private endWarmup(handle: SessionHandle, outcome: 'ready' | 'aborted'): void {
    const span = handle.dvrWarmupSpan;
    if (!span) return;
    handle.dvrWarmupSpan = null;
    span.setAttribute(ATTR.status, outcome);
    span.end();
  }

  /** Playback ended: the presenter consumes the ring tail in real time, then holds the final frame. */
  drainDvr(handle: SessionHandle): void {
    handle.dvrRun?.drain();
    drainRelayAudio(handle.video);
  }

  captureIntoRing(handle: SessionHandle, mediaTime: number): void {
    handle.dvrRun?.onTick(mediaTime);
  }

  syncDvrVerdict(handle: SessionHandle): void {
    handle.dvrRun?.onVerdict();
  }

  /**
   * One engage attempt: delay line first, relay element when the line is
   * permanently unavailable. The outcome goes back to the machine as an
   * audioEngageResult event; the reducer alone decides engaged/retry/withdraw.
   */
  engageAudioRoute(handle: SessionHandle): void {
    const run = handle.dvrRun;
    if (!run) return;
    // Route state, not just run identity: a pause released the route but kept
    // the run — a late engage must not land audio over a frozen canvas.
    const stillWanted = () => handle.dvrRun === run && handle.state.audioRoute === 'pending';
    const report = (result: AudioEngageOutcome) => {
      log.info('video.audio.route', { [ATTR.sessionId]: handle.sessionId, [ATTR.audioRouteResult]: result });
      this.ports.dispatch(handle, { type: 'audioEngageResult', result, at: performance.now() });
    };
    log.debug('video.audio.route', { [ATTR.sessionId]: handle.sessionId, [ATTR.audioRouteResult]: 'attempt' });
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
      .catch((error: unknown) => log.debug('presentation.audio_route_engage.failed', { error }));
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
        log.error('presentation.overlay_work.failed', { error });
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
