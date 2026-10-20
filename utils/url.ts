export function tryParseUrl(href: string | null | undefined): URL | null {
  if (!href) return null;
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

export const isOnHost = (hostname: string, host: string): boolean => hostname === host || hostname.endsWith(`.${host}`);
