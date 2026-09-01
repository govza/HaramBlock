/**
 * Relay Audio (ADR 0001/0002): delayed audio for sources the WebAudio delay
 * line cannot serve. A hidden <audio> plays the video's original URL at
 * `video.currentTime - D` — media playback needs no CORS, only sample readback
 * does. The page element is silenced via `volume = 0` (NOT `muted`: a site
 * mute writes `muted = true`, which on an already-forced-true flag changes
 * nothing and fires no volumechange — the site's mute button would go blind);
 * the site's muted/volume intent is tracked through a shared intent record and
 * restored on release.
 *
 * The intent record also backs the machine's holdPageMute effect (bounded
 * silence while a route is pending), so hold → relay handoff keeps one owner
 * of the page element's audio output.
 */

import { getLogger } from '@/utils/telemetry';

const log = getLogger('relayAudio');

/** Beyond this drift the element seeks; below it playbackRate nudges catch up. */
const HARD_RESYNC_DRIFT_SEC = 0.25;
const RATE_NUDGE_DRIFT_SEC = 0.05;
const RATE_NUDGE_FACTOR = 0.02;
const SYNC_INTERVAL_MS = 500;
/** Element buffering bound: past this the attempt reports transient and retries later. */
const ENGAGE_TIMEOUT_MS = 8_000;

export type SiteAudibleListener = (audible: boolean) => void;

/**
 * Site mute/volume intent for a page element whose volume the extension owns
 * (mute hold or engaged relay). The pending-writes counter attributes
 * async-delivered volumechange events: our own writes must never be misread
 * as site intent (the old synchronous flag was, confirming ADR 0002's bug).
 */
interface MuteIntent {
  siteMuted: boolean;
  siteVolume: number;
  siteAudible: boolean;
  pendingWrites: number;
  onSiteChange: SiteAudibleListener | null;
  release: () => void;
}

const intents = new WeakMap<HTMLVideoElement, MuteIntent>();

interface RelayAudioEntry {
  audio: HTMLAudioElement;
  getDelaySec: () => number;
  /** Last observed page time; a backwards jump marks a loop wrap. */
  lastVideoTime: number;
  /** True once the looping page video wrapped at least once, so a negative
   * target means "tail of the previous pass", not "before playback began". */
  looped: boolean;
  /** DVR drain: the element free-runs the D-second tail on the wall clock. */
  draining: boolean;
  drainTimer: ReturnType<typeof setTimeout> | null;
  teardown: () => void;
}

const entries = new WeakMap<HTMLVideoElement, RelayAudioEntry>();
const inflight = new WeakMap<HTMLVideoElement, Promise<RelayAudioEngageResult>>();
/** Sources whose relay element terminally failed (unsupported/undecodable); never retried. */
const terminalSrcs = new WeakMap<HTMLVideoElement, string>();

export function isRelayAudioEngaged(video: HTMLVideoElement): boolean {
  return entries.has(video);
}

/** The extension currently owns the page element's audio output (hold or relay). */
export function hasMuteIntent(video: HTMLVideoElement): boolean {
  return intents.has(video);
}

function acquireIntent(video: HTMLVideoElement, onSiteChange: SiteAudibleListener | null): MuteIntent {
  const existing = intents.get(video);
  if (existing) {
    if (onSiteChange) existing.onSiteChange = onSiteChange;
    return existing;
  }
  const intent: MuteIntent = {
    siteMuted: video.muted,
    siteVolume: video.volume,
    siteAudible: !video.muted && video.volume > 0,
    pendingWrites: 0,
    onSiteChange,
    release: () => {},
  };
  const onVolumeChange = () => {
    if (intent.pendingWrites > 0) {
      intent.pendingWrites--;
      return;
    }
    intent.siteMuted = video.muted;
    if (video.volume > 0) {
      // A site volume write while we hold zero: record it and re-silence.
      intent.siteVolume = video.volume;
      forceSilence(video, intent);
    }
    const audible = !intent.siteMuted && intent.siteVolume > 0;
    if (audible !== intent.siteAudible) {
      intent.siteAudible = audible;
      intent.onSiteChange?.(audible);
    }
  };
  video.addEventListener('volumechange', onVolumeChange);
  intent.release = () => {
    video.removeEventListener('volumechange', onVolumeChange);
    intents.delete(video);
    video.volume = intent.siteVolume;
  };
  intents.set(video, intent);
  return intent;
}

function forceSilence(video: HTMLVideoElement, intent: MuteIntent): void {
  if (video.volume === 0) return;
  intent.pendingWrites++;
  video.volume = 0;
}

/**
 * Silence the page element while a delayed route is pending, preserving the
 * site's intent. No-op while relay is engaged (it owns the output already).
 */
export function holdPageMute(video: HTMLVideoElement, onSiteChange?: SiteAudibleListener): void {
  if (entries.has(video)) return;
  const intent = acquireIntent(video, onSiteChange ?? null);
  forceSilence(video, intent);
}

/** Restore site intent unless relay took the intent over. */
export function releaseMuteHold(video: HTMLVideoElement): void {
  if (entries.has(video)) return;
  intents.get(video)?.release();
}

export type RelayAudioEngageResult = 'engaged' | 'transient' | 'terminal';

/**
 * Engage delayed audio straight from the video's resolved original URL.
 * Resolves once the hidden element can play ('engaged'), or with why it
 * cannot: 'transient' (buffering timeout, recoverable media error — retry on
 * a later engage) or 'terminal' (no URL, or unsupported/undecodable source).
 */
export function engageRelayAudio(
  video: HTMLVideoElement,
  getDelaySec: () => number,
  onSiteChange?: SiteAudibleListener,
): Promise<RelayAudioEngageResult> {
  const existing = entries.get(video);
  if (existing) {
    existing.getDelaySec = getDelaySec;
    // A replay after a drained natural end re-engages: leave drain mode.
    existing.draining = false;
    if (existing.drainTimer) clearTimeout(existing.drainTimer);
    existing.drainTimer = null;
    return Promise.resolve('engaged');
  }
  const pending = inflight.get(video);
  if (pending) return pending;
  const engage = doEngage(video, getDelaySec, onSiteChange ?? null).finally(() => inflight.delete(video));
  inflight.set(video, engage);
  return engage;
}

async function doEngage(
  video: HTMLVideoElement,
  getDelaySec: () => number,
  onSiteChange: SiteAudibleListener | null,
): Promise<RelayAudioEngageResult> {
  const src = video.currentSrc || video.src;
  if (!src) return 'terminal';
  if (terminalSrcs.get(video) === src) return 'terminal';

  const audio = new Audio(src);
  audio.preload = 'auto';
  audio.loop = video.loop;
  const outcome = await waitForPlayable(audio);
  if (outcome !== 'engaged') {
    audio.removeAttribute('src');
    audio.load();
    if (outcome === 'terminal') terminalSrcs.set(video, src);
    return outcome;
  }
  if (entries.has(video)) return 'engaged';

  const intent = acquireIntent(video, onSiteChange);
  const entry: RelayAudioEntry = {
    audio,
    getDelaySec,
    lastVideoTime: video.currentTime,
    looped: false,
    draining: false,
    drainTimer: null,
    teardown: () => {},
  };
  audio.muted = intent.siteMuted;
  audio.volume = intent.siteVolume;
  forceSilence(video, intent);

  // Runs after the intent listener (registered earlier), so the site intent
  // is already settled for this event.
  const onVolumeChange = () => {
    audio.muted = intent.siteMuted;
    audio.volume = intent.siteVolume;
  };
  const onPlay = () => sync(video, entry);
  const onPause = () => {
    if (!entry.draining) audio.pause();
  };
  video.addEventListener('volumechange', onVolumeChange);
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  const timer = setInterval(() => sync(video, entry), SYNC_INTERVAL_MS);
  entry.teardown = () => {
    clearInterval(timer);
    if (entry.drainTimer) clearTimeout(entry.drainTimer);
    video.removeEventListener('volumechange', onVolumeChange);
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    intents.get(video)?.release();
  };

  entries.set(video, entry);
  sync(video, entry);
  log.debug('relay_audio.engaged');
  return 'engaged';
}

function waitForPlayable(audio: HTMLAudioElement): Promise<RelayAudioEngageResult> {
  const HAVE_FUTURE_DATA = 3;
  if (audio.readyState >= HAVE_FUTURE_DATA) return Promise.resolve('engaged');
  return new Promise(resolve => {
    const settle = (result: RelayAudioEngageResult) => {
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('error', onError);
      clearTimeout(timeout);
      resolve(result);
    };
    const onCanPlay = () => settle('engaged');
    const onError = () => {
      const MEDIA_ERR_DECODE = 3;
      const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
      const code = audio.error?.code;
      settle(code === MEDIA_ERR_DECODE || code === MEDIA_ERR_SRC_NOT_SUPPORTED ? 'terminal' : 'transient');
    };
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('error', onError);
    const timeout = setTimeout(() => settle('transient'), ENGAGE_TIMEOUT_MS);
  });
}

/** Back to native element audio: restore the site's intent and drop the relay element. */
export function releaseRelayAudio(video: HTMLVideoElement): void {
  const entry = entries.get(video);
  if (!entry) return;
  entry.teardown();
  entries.delete(video);
}

/**
 * DVR drain: the page video just ended (and paused), but the delayed tail is
 * still playing out on the canvas. Free-run the element for D more wall-clock
 * seconds so the ending has its sound, then stop.
 */
export function drainRelayAudio(video: HTMLVideoElement): void {
  const entry = entries.get(video);
  if (!entry || entry.draining) return;
  entry.draining = true;
  const { audio } = entry;
  audio.playbackRate = video.playbackRate;
  if (audio.paused) {
    audio.play().catch((error: unknown) => log.debug('relay_audio.drain_play.rejected', { error }));
  }
  entry.drainTimer = setTimeout(() => audio.pause(), entry.getDelaySec() * 1000);
}

/**
 * Track `video.currentTime - D`: hard seek on large drift (loop wraps, user
 * seeks, D raises), gentle rate nudge inside the window so speech never
 * audibly jumps.
 */
function sync(video: HTMLVideoElement, entry: RelayAudioEntry): void {
  const { audio } = entry;
  if (entry.draining) return;
  if (video.paused || video.ended) {
    audio.pause();
    return;
  }
  if (video.loop && video.currentTime + 1 < entry.lastVideoTime) entry.looped = true;
  entry.lastVideoTime = video.currentTime;
  let target = video.currentTime - entry.getDelaySec();
  if (target < 0) {
    const { duration } = audio;
    if (entry.looped && Number.isFinite(duration) && duration > 0) {
      // Just past a loop wrap: the delayed timeline is in the previous pass's tail.
      target = Math.max(0, duration + (target % duration));
    } else {
      // Still inside the pinned start; nothing to say yet.
      audio.pause();
      return;
    }
  }
  const drift = audio.currentTime - target;
  if (Math.abs(drift) > HARD_RESYNC_DRIFT_SEC) {
    audio.currentTime = target;
    audio.playbackRate = video.playbackRate;
  } else if (Math.abs(drift) > RATE_NUDGE_DRIFT_SEC) {
    audio.playbackRate = video.playbackRate * (drift > 0 ? 1 - RATE_NUDGE_FACTOR : 1 + RATE_NUDGE_FACTOR);
  } else {
    audio.playbackRate = video.playbackRate;
  }
  if (audio.paused) {
    // Rejections are rare (unmuted starts follow a user-gesture unmute) and retried here.
    audio.play().catch((error: unknown) => log.debug('relay_audio.play.rejected', { error }));
  }
}
