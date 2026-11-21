import { isGifCandidate } from '@/utils/gifSupport';
import { isOnHost, tryParseUrl } from '@/utils/url';
import { directUrlOfIdentityKey } from '@/utils/videoIdentity';

import type { IReportCandidate, IShareCandidate, ShareableMedia } from '@/utils/types';

const PRIVATE_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home.arpa'];
const UNSHAREABLE_CACHE_DIRECTIVES = new Set(['private', 'no-store', 'no-cache']);
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;
const IPV6_LITERAL = /^\[([0-9a-f:]+)\]$/;
const IPV6_HEXTET_COUNT = 8;
const IPV4_EMBEDDING_PREFIXES = ['0:0:0:0:0:ffff', '0:0:0:0:ffff:0', '64:ff9b:0:0:0:0'];
const UNSPECIFIED_OR_LOOPBACK_PREFIX = '0:0:0:0:0:0';

function isPrivateIpv4(first: number, second: number): boolean {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function expandIpv6(address: string): number[] {
  const [head = '', tail] = address.split('::');
  const hextetsOf = (part: string): number[] => (part ? part.split(':').map(hextet => parseInt(hextet, 16)) : []);
  if (tail === undefined) return hextetsOf(head);
  const leading = hextetsOf(head);
  const trailing = hextetsOf(tail);
  const elided = new Array<number>(IPV6_HEXTET_COUNT - leading.length - trailing.length).fill(0);
  return [...leading, ...elided, ...trailing];
}

function isPrivateIpv6(address: string): boolean {
  const hextets = expandIpv6(address);
  const [first = 0] = hextets;
  const prefix = hextets
    .slice(0, 6)
    .map(hextet => hextet.toString(16))
    .join(':');
  if (prefix === UNSPECIFIED_OR_LOOPBACK_PREFIX) return true;
  if (IPV4_EMBEDDING_PREFIXES.includes(prefix)) {
    const firstTwoOctets = hextets[6] ?? 0;
    return isPrivateIpv4(firstTwoOctets >> 8, firstTwoOctets & 0xff);
  }
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkOrSiteLocal = (first & 0xff80) === 0xfe80;
  return isUniqueLocal || isLinkOrSiteLocal;
}

function isPublicNormalisedHost(normalisedHost: string): boolean {
  const [, ipv6Address] = IPV6_LITERAL.exec(normalisedHost) ?? [];
  if (ipv6Address !== undefined) return !isPrivateIpv6(ipv6Address);
  const ipv4 = IPV4_LITERAL.exec(normalisedHost);
  if (ipv4) return !isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]));
  const host = normalisedHost.replace(/\.$/, '');
  return host.includes('.') && !PRIVATE_HOST_SUFFIXES.some(suffix => isOnHost(host, suffix));
}

function isPublicHostname(hostname: string): boolean {
  const normalisedHost = tryParseUrl(`http://${hostname}/`)?.hostname;
  return normalisedHost !== undefined && isPublicNormalisedHost(normalisedHost);
}

function isPublicHttpUrl(href: string): boolean {
  const url = tryParseUrl(href);
  if (!url) return false;
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
  const hasUserinfo = url.username !== '' || url.password !== '';
  return isHttp && !hasUserinfo && isPublicNormalisedHost(url.hostname);
}

function isShareableVideoKey(identityKey: string): boolean {
  const directUrl = directUrlOfIdentityKey(identityKey);
  return directUrl === null || isPublicHttpUrl(directUrl);
}

function isShareableMedia(media: ShareableMedia): boolean {
  if (media.kind === 'image') return !isGifCandidate(media.src, media.contentType) && isPublicHttpUrl(media.src);
  const { identityKind, identityKey } = media;
  return (
    identityKind === 'stable' && identityKey !== undefined && identityKey !== '' && isShareableVideoKey(identityKey)
  );
}

function forbidsSharedCaching(cacheControl: string): boolean {
  return cacheControl.split(',').some(directive => {
    const [name = '', value = ''] = directive
      .toLowerCase()
      .split('=')
      .map(part => part.trim());
    const isZeroMaxAge = name === 'max-age' && /^"?0+"?$/.test(value);
    return UNSHAREABLE_CACHE_DIRECTIVES.has(name) || isZeroMaxAge;
  });
}

export function isEligibleForLookup({ media, hostname }: IShareCandidate): boolean {
  return isPublicHostname(hostname) && isShareableMedia(media);
}

export function isEligibleForReport(candidate: IReportCandidate, shippedModelIds: ReadonlySet<string>): boolean {
  const { media, modelId } = candidate;
  const isShippedModel = modelId !== undefined && shippedModelIds.has(modelId);
  const isMarkedPrivate =
    media.kind === 'image' && media.cacheControl !== undefined && forbidsSharedCaching(media.cacheControl);
  return isShippedModel && !isMarkedPrivate && isEligibleForLookup(candidate);
}
