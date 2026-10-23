import { resolveVideoIdentity } from '@/entrypoints/content/video/identity/identityResolver';
import { isPendingSameMedia, isSameMedia, UNKNOWN_VIDEO_IDENTITY } from '@/utils/videoIdentity';

import type { VideoIdentity } from '@/utils/types';

/**
 * The media a video element currently plays: a `srcObject` stream or a URL, together with the
 * video identity known when it was resolved (unknown for streams, and until a duration is known).
 */
export interface ResolvedVideoSource {
  srcObject: HTMLVideoElement['srcObject'];
  url: string;
  identity: VideoIdentity;
}

export type SourceRelation = 'sameSource' | 'sameMedia' | 'pendingSameMedia' | 'different';

export function identityOfVideo(video: HTMLVideoElement, sourceUrl: string): VideoIdentity {
  return resolveVideoIdentity({
    sourceUrl,
    pageHref: globalThis.location?.href ?? '',
    durationSec: video.duration,
    video,
  });
}

/** `srcObject` is the active source even if a previous URL is still reflected temporarily. */
export function resolveVideoSource(video: HTMLVideoElement): ResolvedVideoSource | null {
  if (video.srcObject) return { srcObject: video.srcObject, url: '', identity: UNKNOWN_VIDEO_IDENTITY };
  const url = video.currentSrc || video.src;
  return url ? { srcObject: null, url, identity: identityOfVideo(video, url) } : null;
}

const isSameSource = (known: ResolvedVideoSource, next: ResolvedVideoSource): boolean => {
  if (next.srcObject) return known.srcObject === next.srcObject;
  return known.srcObject === null && known.url === next.url;
};

const continuesSameMedia = (known: ResolvedVideoSource, next: ResolvedVideoSource): boolean =>
  known.srcObject === null && next.srcObject === null && isSameMedia(known.identity, next.identity);

const mayContinueSameMedia = (known: ResolvedVideoSource, next: ResolvedVideoSource): boolean =>
  known.srcObject === null && next.srcObject === null && isPendingSameMedia(known.identity, next.identity);

export function compareSources(known: ResolvedVideoSource, next: ResolvedVideoSource): SourceRelation {
  if (isSameSource(known, next)) return 'sameSource';
  if (continuesSameMedia(known, next)) return 'sameMedia';
  if (mayContinueSameMedia(known, next)) return 'pendingSameMedia';
  return 'different';
}
