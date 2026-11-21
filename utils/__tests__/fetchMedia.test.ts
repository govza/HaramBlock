import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCachedMedia } from '@/utils/fetchMedia';

const respondWith = (response: Response) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

describe('fetchCachedMedia', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['private', 'no-store', 'no-cache', 'max-age=0', 'public, max-age=31536000, immutable'])(
    'returns the response Cache-Control "%s" as the site sent it',
    async cacheControl => {
      respondWith(new Response('pixels', { headers: { 'Cache-Control': cacheControl } }));
      expect((await fetchCachedMedia('https://cdn.example.com/a.jpg')).cacheControl).toBe(cacheControl);
    },
  );

  it('returns null when the response has no Cache-Control', async () => {
    respondWith(new Response('pixels'));
    expect((await fetchCachedMedia('https://cdn.example.com/a.jpg')).cacheControl).toBeNull();
  });

  it('returns the response body', async () => {
    respondWith(new Response('pixels'));
    const { blob } = await fetchCachedMedia('https://cdn.example.com/a.jpg');
    expect(await blob.text()).toBe('pixels');
  });

  it('rejects on an error status', async () => {
    respondWith(new Response('', { status: 404 }));
    await expect(fetchCachedMedia('https://cdn.example.com/a.jpg')).rejects.toThrow('404');
  });
});
