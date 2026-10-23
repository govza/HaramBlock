import { tryParseUrl } from '@/utils/url';
import { LOCAL_MEDIA_REFERENCE, UNIDENTIFIABLE_MEDIA_REFERENCE } from '@/utils/videoIdentity';

import type { MediaReference } from '@/utils/types';

const SIGNED_URL_PARAMS = ['expires', 'signature', 'key-pair-id', 'policy', 'hdnts', 'hdntl'];
const SIGNED_URL_PARAM_PREFIXES = ['x-amz-'];

function isAuthParam(name: string): boolean {
  const lower = name.toLowerCase();
  return SIGNED_URL_PARAMS.includes(lower) || SIGNED_URL_PARAM_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function normaliseDirectUrl(url: URL): string {
  const normalised = new URL(url.href);
  normalised.hash = '';
  const authParams = new Set<string>();
  normalised.searchParams.forEach((_value, name) => {
    if (isAuthParam(name)) authParams.add(name);
  });
  for (const name of authParams) normalised.searchParams.delete(name);
  return normalised.href;
}

export function genericMediaReference(sourceUrl: string): MediaReference {
  if (sourceUrl.startsWith('blob:')) return LOCAL_MEDIA_REFERENCE;
  const url = tryParseUrl(sourceUrl);
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') return UNIDENTIFIABLE_MEDIA_REFERENCE;
  return { kind: 'stable', namespace: 'url', id: normaliseDirectUrl(url) };
}
