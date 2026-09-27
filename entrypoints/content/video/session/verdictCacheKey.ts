const VOLATILE_PAGE_PARAMS = new Set(['t', 'start', 'list', 'index', 'pp', 'si', 'feature', 'fbclid', 'gclid']);

export function normalizePageUrl(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (VOLATILE_PAGE_PARAMS.has(name) || name.startsWith('utm_')) url.searchParams.delete(name);
  }
  return url.toString();
}

export function toVerdictCacheKey(sourceUrl: string, pageHref = globalThis.location?.href ?? ''): string {
  if (!sourceUrl) return '';
  if (sourceUrl.startsWith('blob:')) return normalizePageUrl(pageHref);
  return sourceUrl;
}
