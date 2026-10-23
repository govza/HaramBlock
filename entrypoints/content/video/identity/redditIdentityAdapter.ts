import { tryParseUrl } from '@/utils/url';
import { UNIDENTIFIABLE_MEDIA_REFERENCE } from '@/utils/videoIdentity';

import type { VideoIdentityAdapter, VideoIdentityContext } from '@/entrypoints/content/video/identity/identityResolver';
import type { MediaReference, IStableMediaReference } from '@/utils/types';

const VIDEO_MEDIA_HOSTS = new Set(['v.redd.it', 'packaged-media.redd.it']);
const PREVIEW_MEDIA_HOST = 'external-preview.redd.it';
const PLAYER_TAG = 'shreddit-player';
const POST_TAG = 'shreddit-post';
const PLAYER_MEDIA_ATTRS = ['src', 'preview', 'caption-url'];
const POST_MEDIA_ATTR = 'content-href';
const PREVIEW_HASH_PATTERN = /^\/([\w-]+)(?:\.\w+)?$/;

const mediaReferenceOfHref = (href: string | null): IStableMediaReference | null => {
  const url = tryParseUrl(href);
  if (!url) return null;
  if (VIDEO_MEDIA_HOSTS.has(url.hostname)) {
    const mediaId = url.pathname.split('/')[1];
    return mediaId ? { kind: 'stable', namespace: 'vreddit', id: mediaId } : null;
  }
  if (url.hostname === PREVIEW_MEDIA_HOST) {
    const previewHash = PREVIEW_HASH_PATTERN.exec(url.pathname)?.[1];
    return previewHash ? { kind: 'stable', namespace: 'redditpreview', id: previewHash } : null;
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

const redditMediaReference = (context: VideoIdentityContext): MediaReference =>
  mediaHrefsOf(context).map(mediaReferenceOfHref).find(Boolean) ?? UNIDENTIFIABLE_MEDIA_REFERENCE;

export const redditIdentityAdapter: VideoIdentityAdapter = {
  hosts: ['reddit.com'],
  mediaReference: redditMediaReference,
};
