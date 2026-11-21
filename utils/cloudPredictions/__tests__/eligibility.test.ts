import { describe, expect, it } from 'vitest';

import { isEligibleForLookup, isEligibleForReport } from '@/utils/cloudPredictions';

import type { IReportCandidate, ShareableMedia } from '@/utils/types';

const PAGE = 'news.example.com';
const SHIPPED_MODEL_IDS = new Set(['sem-i320', 'sem-i640', 'sem-i320@20260607']);

const image = (src: string, contentType?: string, cacheControl?: string): ShareableMedia => ({
  kind: 'image',
  src,
  contentType,
  cacheControl,
});

describe('media URL', () => {
  it.each([
    ['https', 'https://cdn.example.com/a.jpg'],
    ['http', 'http://cdn.example.com/a.jpg'],
    ['a port', 'https://cdn.example.com:8443/a.jpg'],
    ['a query string', 'https://cdn.example.com/a.jpg?width=320&format=webp'],
    ['a token the strip rule does not know', 'https://cdn.example.com/a.jpg?sig=9f8a7b&exp=1790000000'],
    ['a public IPv4 literal', 'https://93.184.216.34/a.jpg'],
    ['a public IPv6 literal', 'https://[2606:2800:220:1::1]/a.jpg'],
    ['NAT64 of a public address', 'https://[64:ff9b::93.184.216.34]/a.jpg'],
    ['IPv4-mapped IPv6 of a public address', 'https://[::ffff:93.184.216.34]/a.jpg'],
    ['the address just below 172.16/12', 'https://172.15.255.255/a.jpg'],
    ['the address just above 172.16/12', 'https://172.32.0.1/a.jpg'],
    ['a public host that only contains a private suffix', 'https://local.example.com/a.jpg'],
  ])('accepts %s', (_rule, src) => {
    expect(isEligibleForLookup({ media: image(src), hostname: PAGE })).toBe(true);
  });

  it.each([
    ['an unparsable URL', 'not a url'],
    ['an empty URL', ''],
    ['data:', 'data:image/png;base64,AAAA'],
    ['blob:', 'blob:https://example.com/4f6c'],
    ['file:', 'file:///C:/Users/me/a.jpg'],
    ['ftp:', 'ftp://example.com/a.jpg'],
    ['an extension URL', 'chrome-extension://abcdefgh/a.jpg'],
    ['a username', 'https://me@cdn.example.com/a.jpg'],
    ['a username and password', 'https://me:secret@cdn.example.com/a.jpg'],
    ['localhost', 'http://localhost/a.jpg'],
    ['localhost with a port', 'http://localhost:3000/a.jpg'],
    ['a localhost subdomain', 'http://app.localhost/a.jpg'],
    ['a fully qualified localhost', 'http://localhost./a.jpg'],
    ['IPv4 loopback', 'http://127.0.0.1/a.jpg'],
    ['IPv4 loopback in hex notation', 'http://0x7f.1/a.jpg'],
    ['10/8', 'http://10.1.2.3/a.jpg'],
    ['172.16/12 lower edge', 'http://172.16.0.1/a.jpg'],
    ['172.16/12 upper edge', 'http://172.31.255.255/a.jpg'],
    ['192.168/16', 'http://192.168.1.10/a.jpg'],
    ['IPv4 link-local', 'http://169.254.169.254/a.jpg'],
    ['carrier-grade NAT', 'http://100.64.0.1/a.jpg'],
    ['the unspecified IPv4 address', 'http://0.0.0.0/a.jpg'],
    ['IPv6 loopback', 'http://[::1]/a.jpg'],
    ['the unspecified IPv6 address', 'http://[::]/a.jpg'],
    ['IPv6 unique local', 'http://[fd12:3456:789a::1]/a.jpg'],
    ['IPv6 link-local', 'http://[fe80::1]/a.jpg'],
    ['IPv4-mapped IPv6 of a private address', 'http://[::ffff:192.168.1.10]/a.jpg'],
    ['IPv4-compatible IPv6 loopback', 'http://[::127.0.0.1]/a.jpg'],
    ['IPv4-translated IPv6 of a private address', 'http://[::ffff:0:10.0.0.1]/a.jpg'],
    ['NAT64 of a private address', 'http://[64:ff9b::10.0.0.1]/a.jpg'],
    ['IPv6 site-local', 'http://[fec0::1]/a.jpg'],
    ['a single-label host', 'http://nas/a.jpg'],
    ['.local', 'http://printer.local/a.jpg'],
    ['.internal', 'https://wiki.corp.internal/a.jpg'],
    ['.lan', 'http://router.lan/a.jpg'],
    ['.home.arpa', 'http://tv.home.arpa/a.jpg'],
    ['an upper-case private suffix', 'http://PRINTER.LOCAL/a.jpg'],
    ['a private suffix with a trailing dot', 'http://printer.local./a.jpg'],
  ])('rejects %s', (_rule, src) => {
    expect(isEligibleForLookup({ media: image(src), hostname: PAGE })).toBe(false);
  });
});

describe('page hostname', () => {
  const media = image('https://cdn.example.com/a.jpg');

  it.each(['example.com', 'news.example.co.uk', '93.184.216.34'])('accepts %s', hostname => {
    expect(isEligibleForLookup({ media, hostname })).toBe(true);
  });

  it.each([
    '',
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '192.168.1.10',
    '[::1]',
    '[fd12:3456:789a::1]',
    'nas',
    'printer.local',
    'wiki.corp.internal',
    'router.lan',
    'tv.home.arpa',
  ])('rejects %s', hostname => {
    expect(isEligibleForLookup({ media, hostname })).toBe(false);
  });
});

describe('media kind', () => {
  it.each<[string, ShareableMedia, boolean]>([
    ['an image', image('https://cdn.example.com/a.jpg', 'image/jpeg'), true],
    ['a GIF by extension', image('https://cdn.example.com/a.gif'), false],
    ['a GIF by extension before a query', image('https://cdn.example.com/a.GIF?v=2'), false],
    ['a GIF by content type', image('https://cdn.example.com/asset/1', 'image/gif'), false],
    ['an image whose path only mentions gif', image('https://cdn.example.com/giftshop/a.png'), true],
    ['a site-identified video', { kind: 'video', identityKind: 'stable', identityKey: 'yt:dQw4w9WgXcQ' }, true],
    [
      'a directly addressed video',
      { kind: 'video', identityKind: 'stable', identityKey: 'url:https://cdn.example.com/v.mp4?id=7' },
      true,
    ],
    [
      'a directly addressed video on the local network',
      { kind: 'video', identityKind: 'stable', identityKey: 'url:http://192.168.1.10/v.mp4' },
      false,
    ],
    [
      'a video with a page: identity',
      { kind: 'video', identityKind: 'local', identityKey: 'page:https://example.com/watch|d=120' },
      false,
    ],
    ['a video with an unknown identity', { kind: 'video', identityKind: 'unknown' }, false],
    [
      'a video still waiting for its identity',
      { kind: 'video', identityKind: 'unknown', identityKey: 'yt:dQw4w9WgXcQ' },
      false,
    ],
    ['a stable video without a key', { kind: 'video', identityKind: 'stable' }, false],
  ])('%s -> %s', (_rule, media, expected) => {
    expect(isEligibleForLookup({ media, hostname: PAGE })).toBe(expected);
  });
});

describe('report', () => {
  const IMAGE = image('https://cdn.example.com/a.jpg', 'image/jpeg');
  const marked = (cacheControl: string): ShareableMedia =>
    image('https://cdn.example.com/a.jpg', 'image/jpeg', cacheControl);
  const VIDEO: ShareableMedia = { kind: 'video', identityKind: 'stable', identityKey: 'yt:dQw4w9WgXcQ' };
  const report = (overrides: Partial<IReportCandidate>): IReportCandidate => ({
    media: IMAGE,
    hostname: PAGE,
    modelId: 'sem-i320',
    ...overrides,
  });

  it.each<[string, Partial<IReportCandidate>, boolean]>([
    ['an image of a shipped model', {}, true],
    ['a video bucket of a shipped model version', { media: VIDEO, modelId: 'sem-i320@20260607' }, true],
    ['a record of an unknown model', { modelId: 'unknown' }, false],
    ['a record without a model', { modelId: undefined }, false],
    ['a record of a model no longer shipped', { modelId: 'seg-n640' }, false],
    ['a video bucket of a superseded model version', { media: VIDEO, modelId: 'sem-i320@20250101' }, false],
    ['an image without a Cache-Control header', {}, true],
    ['a publicly cacheable image', { media: marked('public, max-age=31536000, immutable') }, true],
    ['a short-lived image', { media: marked('max-age=60') }, true],
    ['an image with s-maxage=0 only', { media: marked('public, s-maxage=0, max-age=600') }, true],
    ['a private image', { media: marked('private, max-age=3600') }, false],
    ['a private image with a field name', { media: marked('private="set-cookie", max-age=3600') }, false],
    ['a no-store image', { media: marked('no-store') }, false],
    ['a no-cache image', { media: marked('max-age=3600, no-cache') }, false],
    ['a max-age=0 image', { media: marked('public, max-age=0') }, false],
    ['a quoted max-age of 0', { media: marked('max-age="0"') }, false],
    ['a spaced max-age of 0', { media: marked('max-age = 0') }, false],
    ['an upper-case directive', { media: marked('Private') }, false],
    ['directives without spaces', { media: marked('public,no-store') }, false],
    ['a GIF', { media: image('https://cdn.example.com/a.gif') }, false],
    ['an image on the local network', { media: image('http://192.168.1.10/a.jpg') }, false],
    ['a page on the local network', { hostname: 'router.lan' }, false],
    [
      'a video with a page: identity',
      { media: { kind: 'video', identityKind: 'local', identityKey: 'page:https://example.com/watch|d=120' } },
      false,
    ],
  ])('%s -> %s', (_rule, overrides, expected) => {
    expect(isEligibleForReport(report(overrides), SHIPPED_MODEL_IDS)).toBe(expected);
  });

  it.each(['private', 'no-store', 'no-cache', 'max-age=0'])('an image marked %s is still looked up', cacheControl => {
    const candidate = report({ media: marked(cacheControl) });

    expect(isEligibleForReport(candidate, SHIPPED_MODEL_IDS)).toBe(false);
    expect(isEligibleForLookup(candidate)).toBe(true);
  });
});
