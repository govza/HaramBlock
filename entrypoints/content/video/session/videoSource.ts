import { resolveVideoIdentity } from '@/entrypoints/content/video/identity/identityResolver';
import { isPendingSameMedia, isSameMedia, UNKNOWN_VIDEO_IDENTITY, type VideoIdentity } from '@/utils/videoIdentity';

/**
 * The media a video element currently plays: a `srcObject` stream or a URL, together with the
 * video identity known when it was resolved (unknown for streams, and until a duration is known).
 */
export interface ResolvedVideoSource {
  srcObject: HTMLVideoElement['srcObject'];
  url: string;
  identity: VideoIdentity;
}

/**
 * How a newly resolved source relates to a known one: the very same source, different source
 * bytes that continue the same media (equal stable or local identities, e.g. rotated signed-URL
 * tokens), a source whose identity is pending on the known media's key (worth waiting for, e.g. a
 * YouTube quality switch before its duration is checked), or different media.
 */
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
