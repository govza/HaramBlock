export function tryParseUrl(href: string | null | undefined): URL | null {
  if (!href) return null;
  try {
    return new URL(href);
  } catch {
    return null;
  }
}
