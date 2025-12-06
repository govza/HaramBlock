import { type ICacheMetadata, type IMediaMetadata } from '@/utils/types';

export function extractMaxAge(cacheControl: string): number | null {
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  return maxAgeMatch && maxAgeMatch[1] ? parseInt(maxAgeMatch[1], 10) : null;
}

export function createCacheMetadataFromMediaMetadata(mediaMetadata: IMediaMetadata): ICacheMetadata {
  const now = Date.now();

  if (mediaMetadata.kind === 'image') {
    const cacheControlHeader = mediaMetadata.cacheControl;
    const contentType = mediaMetadata.contentType ?? 'image/jpeg';
    const maxAge = typeof cacheControlHeader === 'string' ? (extractMaxAge(cacheControlHeader) ?? 3600) : 3600;

    return {
      createdAt: now,
      accessedAt: now,
      maxAge,
      cacheControl: cacheControlHeader || `max-age=${maxAge}`,
      contentType,
    };
  }

  const contentType = mediaMetadata.frameIndex === -1 ? 'video/thumbnail' : 'video/frame';
  return {
    createdAt: now,
    accessedAt: now,
    maxAge: 0,
    cacheControl: 'no-cache',
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
  const expires = headers['expires'] || headers['Expires'];

  let maxAge: number | undefined;
  let expiresTimestamp: number | undefined;

  // Parse Cache-Control max-age
  if (cacheControl) {
    maxAge = extractMaxAge(cacheControl) ?? undefined;
  }

  // Parse Expires header
  if (expires) {
    expiresTimestamp = new Date(expires).getTime();
  }

  // Parse Last-Modified header
  let lastModifiedTimestamp: number | undefined;
  if (lastModified) {
    lastModifiedTimestamp = new Date(lastModified).getTime();
  }

  return {
    cacheControl,
    etag,
    lastModified: lastModifiedTimestamp,
    expires: expiresTimestamp,
    maxAge,
    createdAt: now,
    accessedAt: now,
    contentType,
    contentLength,
  };
}
