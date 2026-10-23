import { isOnHost, tryParseUrl } from '@/utils/url';
import { UNIDENTIFIABLE_MEDIA_REFERENCE } from '@/utils/videoIdentity';

import type { MediaReference } from '@/utils/types';

export const YOUTUBE_HOSTS = ['youtube.com', 'youtube-nocookie.com'] as const;
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

export const isYouTubeHost = (hostname: string): boolean => YOUTUBE_HOSTS.some(host => isOnHost(hostname, host));

const showsAd = (player: Element): boolean => AD_CLASSES.some(name => player.classList.contains(name));

export function youTubeMediaReference(player: Element, adPlaying: boolean, pageHref: string): MediaReference {
  if (adPlaying || showsAd(player)) return UNIDENTIFIABLE_MEDIA_REFERENCE;
  const videoId = playingVideoId(player, pageHref);
  const details = videoDetailsOf(player);
  const lengthSec = Number(details?.lengthSeconds);
  if (!videoId || details?.videoId !== videoId || !(lengthSec > 0)) return UNIDENTIFIABLE_MEDIA_REFERENCE;
  return { kind: 'stable', namespace: 'yt', id: videoId, expectedDurationSec: lengthSec };
}
