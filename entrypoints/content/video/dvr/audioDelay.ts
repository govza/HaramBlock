/**
 * Audio sync for DVR presentation (docs/VIDEO_PROCESSING.md): while the canvas
 * presents `D` behind the live edge, the element's audio is routed through a
 * WebAudio DelayNode with the same delay, so lips match again.
 *
 * `createMediaElementSource` permanently replaces the element's direct output
 * with the graph, and an element can only ever be captured once — so the
 * source node is created once per element and kept for the element's lifetime,
 * toggling between a live route (source → destination) and a delayed route
 * (source → delay → destination). Everything fails toward "audio stays live
 * and audible": a site that already captured the element, a suspended
 * AudioContext (no user gesture yet), or a cross-origin source (whose samples
 * WebAudio would zero out — silence is worse than lip-sync lag) all skip
 * silently.
 */

import { MAX_DVR_DELAY_MS } from '@/entrypoints/content/video/dvr/delay';
import { logger } from '@/utils/logger';

const log = logger.withTag('audioDelay');

/** Smoothing for delay adjustments; jumps click, ramps briefly resample. */
const DELAY_RAMP_TIME_CONSTANT_SEC = 0.3;

interface AudioDelayEntry {
  source: MediaElementAudioSourceNode;
  /** Present only while engaged; a DelayNode is single-use so its buffered tail dies with it. */
  delay: DelayNode | null;
}

/** null = permanently unavailable for this element (already captured by the site). */
const entries = new WeakMap<HTMLVideoElement, AudioDelayEntry | null>();

let sharedContext: AudioContext | null = null;

/**
 * WebAudio outputs zeros for origin-tainted media — routing such audio through
 * the graph would MUTE it. Only sources whose samples are readable qualify.
 * The delayability precondition (ADR 0001): an undelayable source is not
 * processed at all, so this check is exported for the adoption-time gate.
 */
export function isAudioDelayable(video: HTMLVideoElement): boolean {
  if (video.srcObject) return true;
  if (video.crossOrigin) return true;
  const src = video.currentSrc || video.src;
  if (!src) return false;
  if (src.startsWith('blob:') || src.startsWith('data:')) return true;
  try {
    return new URL(src, globalThis.location.href).origin === globalThis.location.origin;
  } catch {
    return false;
  }
}

async function ensureRunningContext(): Promise<AudioContext | null> {
  sharedContext ??= new AudioContext();
  if (sharedContext.state !== 'running') {
    try {
      await sharedContext.resume();
    } catch {
      // No user gesture yet; retry on the next engage.
    }
  }
  return sharedContext.state === 'running' ? sharedContext : null;
}

/**
 * 'unavailable' is permanent for this element (tainted source or captured by
 * the site); 'deferred' is transient (suspended context, torn-down DVR) and
 * safe to retry on a later engage.
 */
export type AudioDelayEngageResult = 'engaged' | 'deferred' | 'unavailable';

/**
 * Engages stack while the AudioContext awaits its user gesture (every verdict
 * retries a deferred engage, and `resume()` stays pending until the gesture):
 * without this guard they would all race `createMediaElementSource` on resume,
 * and the losers' InvalidStateError would mark a just-engaged element
 * permanently unavailable. Concurrent callers share the first call's promise.
 */
const inflight = new WeakMap<HTMLVideoElement, Promise<AudioDelayEngageResult>>();

/**
 * Route the element's audio through the delay line. Async (context resume);
 * `isStillWanted` re-checks after each await so a DVR torn down mid-engage
 * cannot leave live video with delayed audio.
 */
export function engageAudioDelay(
  video: HTMLVideoElement,
  delaySec: number,
  isStillWanted: () => boolean,
): Promise<AudioDelayEngageResult> {
  const pending = inflight.get(video);
  if (pending) return pending;
  const engage = doEngage(video, delaySec, isStillWanted).finally(() => inflight.delete(video));
  inflight.set(video, engage);
  return engage;
}

async function doEngage(
  video: HTMLVideoElement,
  delaySec: number,
  isStillWanted: () => boolean,
): Promise<AudioDelayEngageResult> {
  if (entries.get(video) === null) return 'unavailable';
  if (!isAudioDelayable(video)) return 'unavailable';

  let entry = entries.get(video);
  if (!entry) {
    const context = await ensureRunningContext();
    if (!context || !isStillWanted()) return 'deferred';
    // Re-read after the await (belt-and-braces under the in-flight guard): an
    // entry created or nulled while this call awaited must not be recaptured.
    const settled = entries.get(video);
    if (settled === null) return 'unavailable';
    entry = settled;
  }
  if (!entry) {
    const context = sharedContext;
    if (!context) return 'deferred';
    try {
      const source = context.createMediaElementSource(video);
      source.connect(context.destination);
      entry = { source, delay: null };
      entries.set(video, entry);
    } catch (error) {
      // The site already captured this element into its own graph; its audio
      // routing is not ours to change. Never retry.
      entries.set(video, null);
      log.debug('Cannot capture element audio (already captured?):', error);
      return 'unavailable';
    }
  }

  if (entry.delay) return 'engaged';
  if (!isStillWanted() || !sharedContext) return 'deferred';
  // A fresh DelayNode per engagement: a reused one would still hold the tail
  // it buffered before release and replay stale audio on top of the stream.
  const delay = sharedContext.createDelay(MAX_DVR_DELAY_MS / 1000 + 1);
  delay.delayTime.value = delaySec;
  delay.connect(sharedContext.destination);
  entry.source.disconnect();
  entry.source.connect(delay);
  entry.delay = delay;
  log.debug('Audio delayed by', delaySec, 's');
  return 'engaged';
}

/** Whether this element's audio is currently riding the delay line. */
export function isAudioDelayEngaged(video: HTMLVideoElement): boolean {
  return Boolean(entries.get(video)?.delay);
}

/** Follow the adaptive presentation delay while engaged. */
export function updateAudioDelay(video: HTMLVideoElement, delaySec: number): void {
  const entry = entries.get(video);
  if (!entry?.delay || !sharedContext) return;
  entry.delay.delayTime.setTargetAtTime(delaySec, sharedContext.currentTime, DELAY_RAMP_TIME_CONSTANT_SEC);
}

/**
 * Back to the live route (the element itself jumps forward by D visually too).
 * The delay line is disconnected and discarded, not just bypassed: it still
 * holds D seconds of audio, and left attached to the destination it would
 * drain that tail over the now-live audio.
 *
 * Also the pause path: a DelayNode runs on the audio clock, not the media
 * clock, so a paused element's line keeps draining its buffered D seconds over
 * a canvas frozen at `currentTime − D`. Discarding it kills the tail; the
 * resume path engages a fresh line (which costs D seconds of silence while it
 * refills — the tail is gone either way, and silence beats desynced speech).
 */
export function releaseAudioDelay(video: HTMLVideoElement): void {
  const entry = entries.get(video);
  if (!entry?.delay || !sharedContext) return;
  entry.source.disconnect();
  entry.delay.disconnect();
  entry.delay = null;
  entry.source.connect(sharedContext.destination);
}
