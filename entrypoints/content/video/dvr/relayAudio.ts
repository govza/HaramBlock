/**
 * Relay Audio (ADR 0001): delayed audio for origin-tainted sources the WebAudio
 * delay line cannot serve. The Relay Fetch blob is page-origin, so a hidden
 * <audio> plays it at `video.currentTime - D`. The page element is muted while
 * engaged; the site's muted/volume intent is mirrored and restored on release.
 */

import { logger } from '@/utils/logger';

const log = logger.withTag('relayAudio');

/** Beyond this drift the element seeks; below it playbackRate nudges catch up. */
const HARD_RESYNC_DRIFT_SEC = 0.25;
const RATE_NUDGE_DRIFT_SEC = 0.05;
const RATE_NUDGE_FACTOR = 0.02;
const SYNC_INTERVAL_MS = 500;

interface RelayAudioEntry {
  audio: HTMLAudioElement;
  getDelaySec: () => number;
  /** The page element's muted state as the site last intended it, restored on release. */
  siteMuted: boolean;
  /** Guards the mirror listener against reacting to this module's own mute writes. */
  ourMuteWrite: boolean;
  /** Last observed page time; a backwards jump marks a loop wrap. */
  lastVideoTime: number;
  /** True once the looping page video wrapped at least once, so a negative
   * target means "tail of the previous pass", not "before playback began". */
  looped: boolean;
  teardown: () => void;
}

const entries = new WeakMap<HTMLVideoElement, RelayAudioEntry>();

export function isRelayAudioEngaged(video: HTMLVideoElement): boolean {
  return entries.has(video);
}

/**
 * Engage delayed audio from the Relay Fetch blob. Idempotent; returns false
 * when no blob URL exists yet (the caller retries on later verdicts).
 */
export function engageRelayAudio(video: HTMLVideoElement, blobUrl: string | null, getDelaySec: () => number): boolean {
  const existing = entries.get(video);
  if (existing) {
    existing.getDelaySec = getDelaySec;
    return true;
  }
  if (!blobUrl) return false;

  const audio = new Audio(blobUrl);
  audio.preload = 'auto';
  audio.loop = video.loop;
  const entry: RelayAudioEntry = {
    audio,
    getDelaySec,
    siteMuted: video.muted,
    ourMuteWrite: false,
    lastVideoTime: video.currentTime,
    looped: false,
    teardown: () => {},
  };
  audio.muted = entry.siteMuted;
  audio.volume = video.volume;
  setPageMuted(video, entry, true);

  let lastObservedMuted = video.muted;
  const onVolumeChange = () => {
    if (entry.ourMuteWrite) {
      lastObservedMuted = video.muted;
      return;
    }
    // The page element is force-muted by us; only a real muted flip is site intent.
    if (video.muted !== lastObservedMuted) {
      lastObservedMuted = video.muted;
      entry.siteMuted = video.muted;
      audio.muted = video.muted;
    }
    audio.volume = video.volume;
    // After a site unmute the audible timeline is ours; keep the live edge silent.
    if (!video.muted) setPageMuted(video, entry, true);
  };
  const onPlay = () => sync(video, entry);
  const onPause = () => audio.pause();
  video.addEventListener('volumechange', onVolumeChange);
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  const timer = setInterval(() => sync(video, entry), SYNC_INTERVAL_MS);

  entry.teardown = () => {
    clearInterval(timer);
    video.removeEventListener('volumechange', onVolumeChange);
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setPageMuted(video, entry, entry.siteMuted);
  };

  entries.set(video, entry);
  sync(video, entry);
  log.debug('Relay Audio engaged');
  return true;
}

/** Back to native element audio: restore the site's muted intent and drop the relay element. */
export function releaseRelayAudio(video: HTMLVideoElement): void {
  const entry = entries.get(video);
  if (!entry) return;
  entry.teardown();
  entries.delete(video);
}

function setPageMuted(video: HTMLVideoElement, entry: RelayAudioEntry, muted: boolean): void {
  entry.ourMuteWrite = true;
  video.muted = muted;
  entry.ourMuteWrite = false;
}

/**
 * Track `video.currentTime - D`: hard seek on large drift (loop wraps, user
 * seeks, D raises), gentle rate nudge inside the window so speech never
 * audibly jumps.
 */
function sync(video: HTMLVideoElement, entry: RelayAudioEntry): void {
  const { audio } = entry;
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
    audio.play().catch((error: unknown) => log.debug('Relay Audio play rejected:', error));
  }
}
