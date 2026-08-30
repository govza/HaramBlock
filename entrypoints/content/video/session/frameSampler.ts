/**
 * Frame sampling for a VideoSession (docs/VIDEO_PROCESSING.md): the frame
 * ticker, thumbnail readiness, capture+send rounds, and the per-handle
 * sampling bookkeeping (capture epoch, pending samples, verdict latencies,
 * deferred thumbnail/re-sample flags).
 */

import { cancelVideoSessionInference, requestVideoFrameInference } from '@/entrypoints/content/communication/sender';
import { computeDvrDelayMs, LATENCY_SAMPLE_COUNT } from '@/entrypoints/content/video/dvr/delay';
import { captureFrameBitmap, captureThumbnailBitmap } from '@/entrypoints/content/video/sampling/capture';
import { PermanentFrameTransferError } from '@/entrypoints/content/video/sampling/transfer';
import { INFERENCE_PRIORITY } from '@/utils/constants/inference';
import { logger } from '@/utils/logger';

import type { CapturedFrameSample, PendingFrameSample } from '@/entrypoints/content/video/sampling/sample';
import type { SessionHandle } from '@/entrypoints/content/video/session/handle';
import type { SessionEvent } from '@/entrypoints/content/video/session/machine';

const log = logger.withTag('videoSession:sampler');

/**
 * Ceiling on one capture+send round. The machine frees the in-flight slot on
 * sendFailed, but only if the promise settles: a CORS-clone or poster load on
 * a blackholed network fires neither 'loadeddata' nor 'error' and would
 * otherwise occupy the slot forever, stalling sampling under the watchdog blur.
 */
const CAPTURE_SEND_TIMEOUT_MS = 10_000;

/**
 * A verdict that never arrives leaves its pending Frame Sample behind (the
 * sampleTimeout only frees the machine's slot), so an inference outage would
 * grow the map for the session's lifetime. Entries this old are useless to the
 * delay estimator anyway — prune them on the next send.
 */
const SAMPLE_LATENCY_EXPIRY_MS = 30_000;

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

export interface SamplerPorts {
  dispatch(handle: SessionHandle, event: SessionEvent): void;
  /** Feed the DVR ring on each ticker frame (presentationAdapter.ts). */
  captureIntoRing(handle: SessionHandle, mediaTime: number): void;
}

export class FrameSampler {
  constructor(private readonly ports: SamplerPorts) {}

  startTicker(handle: SessionHandle): void {
    // 'error' keeps its ticker stopped by the machine's own stopTicker/resumeTicker
    // protocol (cooldown expiry re-arms it); a viewport resume must not override that.
    if (handle.stopTicker || handle.suspended) return;
    if (handle.state.phase === 'disposed' || handle.state.phase === 'error') return;
    handle.stopTicker = startFrameTicker(handle.video, (at, mediaTime) => {
      this.ports.dispatch(handle, { type: 'frameAvailable', at, timestampSec: mediaTime });
      this.ports.captureIntoRing(handle, mediaTime);
    });
  }

  stopTicker(handle: SessionHandle): void {
    handle.stopTicker?.();
    handle.stopTicker = null;
  }

  /** Execute the machine's captureThumbnail effect; deferred while suspended. */
  captureThumbnail(handle: SessionHandle): void {
    if (handle.suspended) {
      handle.pendingThumbnailCapture = true;
    } else {
      handle.pendingThumbnailCapture = false;
      void this.captureAndSend(handle, -1, 0);
    }
  }

  /**
   * Invalidate sampling across a suspend: captures already in flight must not
   * send their pre-suspension frame after a fast suspend→resume (it would
   * evict a fresher queued frame in the background and restart sampleTimeout),
   * and the background's queued frame for this session is cancelled.
   *
   * Suspend-only: it arms pendingResample so the resume re-samples the frame
   * that lost its verdict. Call it with handle.suspended already true.
   */
  invalidateForSuspend(handle: SessionHandle): void {
    handle.captureEpoch += 1;
    if (handle.sentPlaybackFrame) void cancelVideoSessionInference(handle.sessionId);
    const { inflightIndex } = handle.state;
    if (inflightIndex !== null) {
      handle.pendingSamples.delete(inflightIndex);
      // The displayed frame loses its pending verdict; a paused resume must re-sample it.
      handle.pendingResample = true;
      this.ports.dispatch(handle, { type: 'sampleCancelled', frameIndex: inflightIndex, at: performance.now() });
    }
  }

  /** Fire a thumbnail capture that was deferred while suspended. */
  replayDeferredThumbnail(handle: SessionHandle): void {
    if (!handle.pendingThumbnailCapture) return;
    handle.pendingThumbnailCapture = false;
    // Replay whenever the session is still verdict-less, not only in
    // THUMBNAILING: play can preempt readiness, leaving the machine to
    // re-signal captureThumbnail from standby/sampling with no timer armed —
    // gating on phase would strand the deferred capture and the blur forever.
    if (handle.state.lastAppliedIndex === Number.NEGATIVE_INFINITY && handle.state.phase !== 'error') {
      void this.captureAndSend(handle, -1, 0);
    }
  }

  /** Recent sample→verdict round-trips converted to the adaptive DVR delay, in seconds. */
  currentDvrDelaySec(handle: SessionHandle): number {
    return computeDvrDelayMs(handle.latenciesMs) / 1000;
  }

  /** Read-and-clear the deferred re-sample flag (see SessionHandle.pendingResample). */
  consumePendingResample(handle: SessionHandle): boolean {
    const pending = handle.pendingResample;
    handle.pendingResample = false;
    return pending;
  }

  /** Drop a deferred re-sample without acting on it, when fresh sampling supersedes it. */
  discardPendingResample(handle: SessionHandle): void {
    handle.pendingResample = false;
  }

  /**
   * Settle the pending Frame Sample a verdict answers, recording its
   * round-trip for the adaptive DVR delay. Returns false for verdicts with no
   * pending sample (expired, cancelled, or re-delivered).
   */
  recordVerdictLatency(handle: SessionHandle, frameIndex: number): boolean {
    const sample = handle.pendingSamples.get(frameIndex);
    if (!sample) return false;
    handle.pendingSamples.delete(frameIndex);
    handle.latenciesMs.push(performance.now() - sample.capturedAt);
    if (handle.latenciesMs.length > LATENCY_SAMPLE_COUNT) handle.latenciesMs.shift();
    return true;
  }

  /** Release sampling resources at session teardown. */
  teardown(handle: SessionHandle): void {
    if (handle.sentPlaybackFrame) void cancelVideoSessionInference(handle.sessionId);
    this.stopTicker(handle);
    handle.pendingSamples.clear();
  }

  /**
   * Signal Thumbnail readiness: a poster needs no video data at all; otherwise
   * wait for the first frame. preload="none" without a poster stays in ADOPTED
   * (blurred, nothing rendered) until data or playback arrives.
   */
  queueThumbnailSourceReady(handle: SessionHandle): void {
    const { video } = handle;
    const ready = () => this.ports.dispatch(handle, { type: 'thumbnailSourceReady' });

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

  async captureAndSend(handle: SessionHandle, frameIndex: number, timestampSec: number): Promise<void> {
    const { video } = handle;
    const isDisposed = () => handle.state.phase === 'disposed';
    if (isDisposed()) return;
    if (handle.suspended) {
      if (frameIndex === -1) {
        handle.pendingThumbnailCapture = true;
      } else {
        handle.pendingResample = true;
        this.ports.dispatch(handle, { type: 'sampleCancelled', frameIndex, at: performance.now() });
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
          this.ports.dispatch(handle, { type: 'sampleCancelled', frameIndex, at: performance.now() });
        }
        return;
      }
      const { bitmap } = captured;
      if (!bitmap || bitmap.width === 0 || bitmap.height === 0) {
        bitmap?.close();
        handle.pendingSamples.delete(frameIndex);
        this.ports.dispatch(handle, {
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
      this.ports.dispatch(handle, { type: 'sampleSent', frameIndex, at: performance.now() });
    } catch (error) {
      const permanent = error instanceof PermanentFrameTransferError;
      if (permanent) log.warn('Frame Sample cannot be serialized for inference:', error);
      else log.error('Frame Sample capture/send failed:', error);
      handle.pendingSamples.delete(frameIndex);
      this.ports.dispatch(handle, { type: 'sendFailed', frameIndex, at: performance.now(), permanent });
    }
  }
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
