export function withoutFragment(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  url.hash = '';
  return url.href;
}

export function toVerdictCacheKey(sourceUrl: string, pageHref = globalThis.location?.href ?? ''): string {
  if (!sourceUrl) return '';
  if (sourceUrl.startsWith('blob:')) return withoutFragment(pageHref);
  return sourceUrl;
}
