import { UNKNOWN_VIDEO_IDENTITY, type VideoIdentity } from '@/utils/videoIdentity';

const SIGNED_URL_PARAMS = new Set(['expires', 'signature', 'key-pair-id', 'policy', 'hdnts', 'hdntl']);
const SIGNED_URL_PARAM_PREFIXES = ['x-amz-'];
const DURATION_KEY_STEP_SEC = 0.1;

const isSignedUrlParam = (name: string): boolean => {
  const lower = name.toLowerCase();
  return SIGNED_URL_PARAMS.has(lower) || SIGNED_URL_PARAM_PREFIXES.some(prefix => lower.startsWith(prefix));
};

const parseUrl = (href: string): URL | null => {
  try {
    return new URL(href);
  } catch {
    return null;
  }
};

export function withoutFragment(href: string): string {
  const url = parseUrl(href);
  if (!url) return href;
  url.hash = '';
  return url.href;
}

export function normaliseDirectUrl(url: URL): string {
  const normalised = new URL(url.href);
  normalised.hash = '';
  for (const name of [...new Set(normalised.searchParams.keys())]) {
    if (isSignedUrlParam(name)) normalised.searchParams.delete(name);
  }
  return normalised.href;
}

export const isKnownDuration = (durationSec: number): boolean => Number.isFinite(durationSec) && durationSec > 0;

const durationKeyOf = (durationSec: number): number => Math.round(durationSec / DURATION_KEY_STEP_SEC);

/**
 * Identifies media no site adapter recognised: a direct `http(s)` file stably by its URL without
 * auth tokens, an MSE source locally by its page and duration, anything else not at all.
 */
export function genericVideoIdentity(sourceUrl: string, pageHref: string, durationSec: number): VideoIdentity {
  if (!isKnownDuration(durationSec)) return UNKNOWN_VIDEO_IDENTITY;
  if (sourceUrl.startsWith('blob:')) {
    return { kind: 'local', key: `page:${withoutFragment(pageHref)}|d=${durationKeyOf(durationSec)}`, durationSec };
  }
  const url = parseUrl(sourceUrl);
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') return UNKNOWN_VIDEO_IDENTITY;
  return { kind: 'stable', key: `url:${normaliseDirectUrl(url)}`, durationSec };
}
