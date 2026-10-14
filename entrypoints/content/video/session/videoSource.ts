import { toVerdictCacheKey } from '@/entrypoints/content/video/session/verdictCacheKey';

/**
 * The media a video element currently plays: a `srcObject` stream or a URL, together with the
 * verdict cache key derived from that URL when it was resolved (empty for streams).
 */
export interface ResolvedVideoSource {
  srcObject: HTMLVideoElement['srcObject'];
  url: string;
  cacheKey: string;
}

/**
 * How a newly resolved source relates to a known one: the very same source, different source
 * bytes that continue the same media (same verdict cache key, e.g. a YouTube quality switch), or
 * different media.
 */
export type SourceRelation = 'sameSource' | 'sameMedia' | 'different';

/** `srcObject` is the active source even if a previous URL is still reflected temporarily. */
export function resolveVideoSource(video: HTMLVideoElement): ResolvedVideoSource | null {
  if (video.srcObject) return { srcObject: video.srcObject, url: '', cacheKey: '' };
  const url = video.currentSrc || video.src;
  return url ? { srcObject: null, url, cacheKey: toVerdictCacheKey(url) } : null;
}

const isSameSource = (known: ResolvedVideoSource, next: ResolvedVideoSource): boolean => {
  if (next.srcObject) return known.srcObject === next.srcObject;
  return known.srcObject === null && known.url === next.url;
};

const continuesSameMedia = (known: ResolvedVideoSource, next: ResolvedVideoSource): boolean =>
  known.srcObject === null && next.srcObject === null && known.cacheKey !== '' && known.cacheKey === next.cacheKey;

export function compareSources(known: ResolvedVideoSource, next: ResolvedVideoSource): SourceRelation {
  if (isSameSource(known, next)) return 'sameSource';
  if (continuesSameMedia(known, next)) return 'sameMedia';
  return 'different';
}
