/**
 * Fetches media the page already loaded, preferring the HTTP cache, and returns its body with the
 * response's own `Cache-Control` (null when the site sent none).
 */
export async function fetchCachedMedia(src: string): Promise<{ blob: Blob; cacheControl: string | null }> {
  const response = await fetch(src, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${src} (${response.status})`);
  }
  return { blob: await response.blob(), cacheControl: response.headers.get('cache-control') };
}
