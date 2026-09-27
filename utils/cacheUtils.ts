import { type ICacheMetadata, type IMediaMetadata } from '@/utils/types';

const DAY_SEC = 24 * 60 * 60;
export const MIN_CACHE_MAX_AGE_SEC = 30 * DAY_SEC;
export const MAX_CACHE_MAX_AGE_SEC = 90 * DAY_SEC;

export function clampMaxAge(maxAge: number | null | undefined): number {
  if (maxAge === null || maxAge === undefined || !Number.isFinite(maxAge)) return MIN_CACHE_MAX_AGE_SEC;
  return Math.min(MAX_CACHE_MAX_AGE_SEC, Math.max(MIN_CACHE_MAX_AGE_SEC, maxAge));
}

export function extractMaxAge(cacheControl: string): number | null {
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  return maxAgeMatch && maxAgeMatch[1] ? parseInt(maxAgeMatch[1], 10) : null;
}

export function createCacheMetadataFromMediaMetadata(mediaMetadata: IMediaMetadata): ICacheMetadata {
  const now = Date.now();

  if (mediaMetadata.kind === 'image') {
    const cacheControlHeader = mediaMetadata.cacheControl;
    const contentType = mediaMetadata.contentType ?? 'image/jpeg';
    const maxAge = clampMaxAge(typeof cacheControlHeader === 'string' ? extractMaxAge(cacheControlHeader) : null);

    return {
      createdAt: now,
      accessedAt: now,
      maxAge,
      cacheControl: cacheControlHeader || `max-age=${maxAge}`,
      contentType,
    };
  }

  const contentType = mediaMetadata.frameIndex === -1 ? 'video/thumbnail' : 'video/frame';
  const maxAge = clampMaxAge(null);
  return {
    createdAt: now,
    accessedAt: now,
    maxAge,
    cacheControl: `max-age=${maxAge}`,
    contentType,
  };
}

/**
 * Create cache metadata from HTTP response headers
 * @param headers - HTTP response headers
 * @param contentType - MIME type of the image
 * @param contentLength - Size of the image in bytes
 * @returns Cache metadata object
 */
export function createCacheMetadata(
  headers: Record<string, string> = {},
  contentType?: string,
  contentLength?: number,
): ICacheMetadata {
  const now = Date.now();
  const cacheControl = headers['cache-control'] || headers['Cache-Control'];
  const etag = headers['etag'] || headers['ETag'];
  const lastModified = headers['last-modified'] || headers['Last-Modified'];

  const maxAge = clampMaxAge(cacheControl ? extractMaxAge(cacheControl) : null);

  // Parse Last-Modified header
  let lastModifiedTimestamp: number | undefined;
  if (lastModified) {
    lastModifiedTimestamp = new Date(lastModified).getTime();
  }

  return {
    cacheControl,
    etag,
    lastModified: lastModifiedTimestamp,
    maxAge,
    createdAt: now,
    accessedAt: now,
    contentType,
    contentLength,
  };
}
