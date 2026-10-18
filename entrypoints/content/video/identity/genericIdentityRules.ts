import { tryParseUrl } from '@/utils/url';
import {
  isKnownDuration,
  localPageIdentity,
  stableIdentity,
  UNKNOWN_VIDEO_IDENTITY,
  type VideoIdentity,
} from '@/utils/videoIdentity';

const SIGNED_URL_PARAMS = new Set(['expires', 'signature', 'key-pair-id', 'policy', 'hdnts', 'hdntl']);
const SIGNED_URL_PARAM_PREFIXES = ['x-amz-'];

const isSignedUrlParam = (name: string): boolean => {
  const lower = name.toLowerCase();
  return SIGNED_URL_PARAMS.has(lower) || SIGNED_URL_PARAM_PREFIXES.some(prefix => lower.startsWith(prefix));
};

function normaliseDirectUrl(url: URL): string {
  const normalised = new URL(url.href);
  normalised.hash = '';
  for (const name of [...new Set(normalised.searchParams.keys())]) {
    if (isSignedUrlParam(name)) normalised.searchParams.delete(name);
  }
  return normalised.href;
}

export function genericVideoIdentity(sourceUrl: string, pageHref: string, durationSec: number): VideoIdentity {
  if (!isKnownDuration(durationSec)) return UNKNOWN_VIDEO_IDENTITY;
  if (sourceUrl.startsWith('blob:')) return localPageIdentity(pageHref, durationSec);
  const url = tryParseUrl(sourceUrl);
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') return UNKNOWN_VIDEO_IDENTITY;
  return stableIdentity('url', normaliseDirectUrl(url), durationSec);
}
