import { tryParseUrl } from '@/utils/url';
import {
  SAME_DURATION_TOLERANCE_SEC,
  stableIdentity,
  stableIdentityKey,
  UNKNOWN_VIDEO_IDENTITY,
  type VideoIdentity,
} from '@/utils/videoIdentity';

export const YOUTUBE_HOST = /(^|\.)youtube(-nocookie)?\.com$/;
export const YOUTUBE_PLAYER_SELECTOR = '.html5-video-player';

const YOUTUBE_PATH_VIDEO_ID = /^\/(?:shorts|live|embed)\/([\w-]+)/;
const AD_CLASSES = ['ad-showing', 'ad-interrupting'];

/**
 * The fields of YouTube's player response that name the video it describes, its length and whether it is a live or
 * post-live DVR stream rather than VOD.
 */
export interface YouTubeVideoDetails {
  videoId?: string;
  lengthSeconds?: string;
  isLive?: boolean;
  isPostLiveDvr?: boolean;
}

export function callPlayer(player: Element, name: string): unknown {
  const method: unknown = Reflect.get(player, name);
  return typeof method === 'function' ? Reflect.apply(method, player, []) : undefined;
}

export function objectOrUndefined(value: unknown): object | undefined {
  return value && typeof value === 'object' ? value : undefined;
}

export function videoIdInUrl(href: string): string | undefined {
  const url = tryParseUrl(href);
  if (!url) return undefined;
  return url.searchParams.get('v') ?? YOUTUBE_PATH_VIDEO_ID.exec(url.pathname)?.[1];
}

export function playingVideoId(player: Element, pageHref: string): string | undefined {
  const playing: unknown = Reflect.get(objectOrUndefined(callPlayer(player, 'getVideoData')) ?? {}, 'video_id');
  if (typeof playing === 'string' && playing) return playing;
  return videoIdInUrl(pageHref);
}

export function videoDetailsOf(player: Element): YouTubeVideoDetails | undefined {
  const response = objectOrUndefined(callPlayer(player, 'getPlayerResponse'));
  return objectOrUndefined(response && Reflect.get(response, 'videoDetails'));
}

const showsAd = (player: Element): boolean => AD_CLASSES.some(name => player.classList.contains(name));

/**
 * Identifies the media a YouTube player plays by its video id: unknown while the player shows an ad or its player
 * response describes another video, pending until the `MediaSource` duration is known, and stable only when that
 * duration matches the video's length.
 */
export function youTubeVideoIdentity(
  player: Element,
  mediaDurationSec: number,
  adPlaying: boolean,
  pageHref: string,
): VideoIdentity {
  if (adPlaying || showsAd(player)) return UNKNOWN_VIDEO_IDENTITY;
  const videoId = playingVideoId(player, pageHref);
  const details = videoDetailsOf(player);
  const lengthSec = Number(details?.lengthSeconds);
  if (!videoId || details?.videoId !== videoId || !(lengthSec > 0)) return UNKNOWN_VIDEO_IDENTITY;
  if (Number.isNaN(mediaDurationSec)) return { kind: 'unknown', pendingKey: stableIdentityKey('yt', videoId) };
  if (!(Math.abs(mediaDurationSec - lengthSec) <= SAME_DURATION_TOLERANCE_SEC)) return UNKNOWN_VIDEO_IDENTITY;
  return stableIdentity('yt', videoId, mediaDurationSec);
}
