import { tryParseUrl } from '@/utils/url';
import { isKnownDuration, stableIdentityKey, UNKNOWN_VIDEO_IDENTITY, type VideoIdentity } from '@/utils/videoIdentity';

import type { VideoIdentityAdapter, VideoIdentityContext } from '@/entrypoints/content/video/identity/identityResolver';

const REDDIT_HOSTNAME = 'reddit.com';
const VIDEO_MEDIA_HOSTS = new Set(['v.redd.it', 'packaged-media.redd.it']);
const PREVIEW_MEDIA_HOST = 'external-preview.redd.it';
const PLAYER_TAG = 'shreddit-player';
const POST_TAG = 'shreddit-post';
const PLAYER_MEDIA_ATTRS = ['src', 'preview', 'caption-url'];
const POST_MEDIA_ATTR = 'content-href';
const PREVIEW_HASH_PATTERN = /^\/([\w-]+)(?:\.\w+)?$/;

const isRedditPage = (location: URL): boolean =>
  location.hostname === REDDIT_HOSTNAME || location.hostname.endsWith(`.${REDDIT_HOSTNAME}`);

const mediaKeyOf = (href: string | null): string | null => {
  const url = tryParseUrl(href);
  if (!url) return null;
  if (VIDEO_MEDIA_HOSTS.has(url.hostname)) {
    const mediaId = url.pathname.split('/')[1];
    return mediaId ? stableIdentityKey('vreddit', mediaId) : null;
  }
  if (url.hostname === PREVIEW_MEDIA_HOST) {
    const previewHash = PREVIEW_HASH_PATTERN.exec(url.pathname)?.[1];
    return previewHash ? stableIdentityKey('redditpreview', previewHash) : null;
  }
  return null;
};

const composedParentOf = (node: Node): Node | null => {
  if (node.parentNode instanceof ShadowRoot) return node.parentNode.host;
  return node.parentNode;
};

const closestComposed = (start: Node, tagName: string): Element | null => {
  for (let node: Node | null = start; node; node = composedParentOf(node)) {
    if (node instanceof Element && node.localName === tagName) return node;
  }
  return null;
};

const mediaHrefsOf = ({ sourceUrl, video }: VideoIdentityContext): (string | null)[] => {
  if (!video) return [sourceUrl];
  const player = closestComposed(video, PLAYER_TAG);
  const post = closestComposed(player ?? video, POST_TAG);
  return [
    sourceUrl,
    ...PLAYER_MEDIA_ATTRS.map(name => player?.getAttribute(name) ?? null),
    post?.getAttribute(POST_MEDIA_ATTR) ?? null,
  ];
};

/**
 * Names Reddit media by its `v.redd.it` media id (or a comment GIF's preview hash) read from the
 * video's source or its owning player and post, never the signed URL, which changes per page load.
 * Unidentified Reddit media stays unknown rather than falling through to the generic `url:` rule.
 */
const resolveRedditIdentity = (context: VideoIdentityContext): VideoIdentity => {
  if (!isKnownDuration(context.durationSec)) return UNKNOWN_VIDEO_IDENTITY;
  const key = mediaHrefsOf(context).map(mediaKeyOf).find(Boolean);
  return key ? { kind: 'stable', key, durationSec: context.durationSec } : UNKNOWN_VIDEO_IDENTITY;
};

export const redditIdentityAdapter: VideoIdentityAdapter = {
  matches: isRedditPage,
  resolve: resolveRedditIdentity,
};
