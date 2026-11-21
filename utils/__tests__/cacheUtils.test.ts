import { describe, expect, it } from 'vitest';

import {
  clampMaxAge,
  createCacheMetadata,
  createCacheMetadataFromMediaMetadata,
  MAX_CACHE_MAX_AGE_SEC,
  MIN_CACHE_MAX_AGE_SEC,
} from '@/utils/cacheUtils';

import type { IMediaMetadata } from '@/utils/types';

describe('clampMaxAge', () => {
  it('raises short and missing max-age to the floor', () => {
    expect(clampMaxAge(0)).toBe(MIN_CACHE_MAX_AGE_SEC);
    expect(clampMaxAge(3600)).toBe(MIN_CACHE_MAX_AGE_SEC);
    expect(clampMaxAge(null)).toBe(MIN_CACHE_MAX_AGE_SEC);
    expect(clampMaxAge(undefined)).toBe(MIN_CACHE_MAX_AGE_SEC);
  });

  it('caps huge max-age at the ceiling', () => {
    expect(clampMaxAge(10 * MAX_CACHE_MAX_AGE_SEC)).toBe(MAX_CACHE_MAX_AGE_SEC);
  });

  it('keeps values inside the range', () => {
    const inside = MIN_CACHE_MAX_AGE_SEC + 1;
    expect(clampMaxAge(inside)).toBe(inside);
  });
});

describe('createCacheMetadata', () => {
  it('clamps header max-age and ignores Expires', () => {
    const metadata = createCacheMetadata({ 'cache-control': 'max-age=60', expires: 'Thu, 01 Jan 1970 00:00:00 GMT' });
    expect(metadata.maxAge).toBe(MIN_CACHE_MAX_AGE_SEC);
    expect(metadata.expires).toBeUndefined();
  });
});

describe('createCacheMetadataFromMediaMetadata', () => {
  it('gives video frames a cacheable max-age', () => {
    const frame = { kind: 'frame', frameIndex: 3 } as IMediaMetadata;
    expect(createCacheMetadataFromMediaMetadata(frame).maxAge).toBe(MIN_CACHE_MAX_AGE_SEC);
  });

  it('clamps image no-cache headers to the floor', () => {
    const image = { kind: 'image', cacheControl: 'no-cache, max-age=0' } as IMediaMetadata;
    expect(createCacheMetadataFromMediaMetadata(image).maxAge).toBe(MIN_CACHE_MAX_AGE_SEC);
  });

  it.each(['private', 'no-store', 'no-cache', 'max-age=0', 'Public, Max-Age=31536000 , immutable'])(
    'keeps the image response header "%s" unmodified',
    cacheControl => {
      const image = { kind: 'image', cacheControl } as IMediaMetadata;
      expect(createCacheMetadataFromMediaMetadata(image).cacheControl).toBe(cacheControl);
    },
  );

  it('stores an image response without the header as absent, with the floor lifetime', () => {
    const image = { kind: 'image', cacheControl: null } as IMediaMetadata;
    const metadata = createCacheMetadataFromMediaMetadata(image);
    expect(metadata).not.toHaveProperty('cacheControl');
    expect(metadata.maxAge).toBe(MIN_CACHE_MAX_AGE_SEC);
  });

  it('keeps a long image max-age as the lifetime, capped at the ceiling', () => {
    const inside = MIN_CACHE_MAX_AGE_SEC + 1;
    const image = (cacheControl: string) => ({ kind: 'image', cacheControl }) as IMediaMetadata;
    expect(createCacheMetadataFromMediaMetadata(image(`max-age=${inside}`)).maxAge).toBe(inside);
    expect(createCacheMetadataFromMediaMetadata(image('max-age=999999999')).maxAge).toBe(MAX_CACHE_MAX_AGE_SEC);
  });
});
