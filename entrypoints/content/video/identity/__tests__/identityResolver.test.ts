import { describe, expect, it } from 'vitest';

import {
  resolveVideoIdentity,
  type VideoIdentityAdapter,
  type VideoIdentityContext,
} from '@/entrypoints/content/video/identity/identityResolver';

import type { MediaReference } from '@/utils/types';

const PAGE = 'https://www.example.test/feed?tab=new#comments';

const context = (overrides: Partial<VideoIdentityContext>): VideoIdentityContext => ({
  sourceUrl: '',
  pageHref: PAGE,
  durationSec: 12.34,
  ...overrides,
});

describe('resolveVideoIdentity: MSE sources', () => {
  it('identifies an MSE source locally by its page without fragment and its duration in whole seconds', () => {
    expect(resolveVideoIdentity(context({ sourceUrl: 'blob:https://www.example.test/1a2b' }))).toEqual({
      kind: 'local',
      key: 'page:https://www.example.test/feed?tab=new|d=12',
      durationSec: 12.34,
    });
  });

  it('keeps one local identity across small duration jitter between loads', () => {
    const keyAt = (durationSec: number) =>
      resolveVideoIdentity(context({ sourceUrl: 'blob:https://www.example.test/a', durationSec }));
    expect(keyAt(600.04)).toHaveProperty('key', 'page:https://www.example.test/feed?tab=new|d=600');
    expect(keyAt(600.06)).toHaveProperty('key', 'page:https://www.example.test/feed?tab=new|d=600');
  });

  it('keeps two MSE videos on one page with different durations apart', () => {
    const first = resolveVideoIdentity(context({ sourceUrl: 'blob:https://www.example.test/a', durationSec: 30 }));
    const second = resolveVideoIdentity(context({ sourceUrl: 'blob:https://www.example.test/b', durationSec: 45.2 }));
    expect(first).not.toEqual(second);
  });

  it('leaves an MSE source unknown until a duration is known', () => {
    expect(resolveVideoIdentity(context({ sourceUrl: 'blob:https://x.test/a', durationSec: Number.NaN }))).toEqual({
      kind: 'unknown',
    });
    expect(resolveVideoIdentity(context({ sourceUrl: 'blob:https://x.test/a', durationSec: 0 }))).toEqual({
      kind: 'unknown',
    });
  });

  it('leaves a live MSE source unknown', () => {
    const live = context({ sourceUrl: 'blob:https://x.test/a', durationSec: Number.POSITIVE_INFINITY });
    expect(resolveVideoIdentity(live)).toEqual({ kind: 'unknown' });
  });
});

describe('resolveVideoIdentity: direct files', () => {
  const keyOf = (sourceUrl: string) => {
    const identity = resolveVideoIdentity(context({ sourceUrl }));
    return identity.kind === 'unknown' ? null : identity.key;
  };

  it('identifies a direct file stably by its normalised URL', () => {
    expect(resolveVideoIdentity(context({ sourceUrl: 'HTTPS://CDN.Example.TEST/Clip.mp4#t=5' }))).toEqual({
      kind: 'stable',
      key: 'url:https://cdn.example.test/Clip.mp4',
      durationSec: 12.34,
    });
  });

  it('reuses one identity after CloudFront signed-URL tokens rotate', () => {
    expect(keyOf('https://d1.cloudfront.net/v.mp4?Expires=1&Signature=abc&Key-Pair-Id=K1')).toBe(
      keyOf('https://d1.cloudfront.net/v.mp4?Expires=2&Signature=def&Key-Pair-Id=K2&Policy=p'),
    );
    expect(keyOf('https://d1.cloudfront.net/v.mp4?Expires=1&Signature=abc')).toBe(
      'url:https://d1.cloudfront.net/v.mp4',
    );
  });

  it('strips S3 X-Amz-* params whatever their case', () => {
    expect(
      keyOf(
        'https://b.s3.amazonaws.com/v.mp4?X-Amz-Algorithm=AWS4&X-Amz-Credential=c&x-amz-date=d&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=s&X-Amz-Security-Token=t',
      ),
    ).toBe('url:https://b.s3.amazonaws.com/v.mp4');
  });

  it('strips Akamai hdnts and hdntl tokens', () => {
    expect(keyOf('https://a.akamaized.net/v.mp4?hdnts=exp~1&hdntl=acl~2')).toBe('url:https://a.akamaized.net/v.mp4');
  });

  it('keeps params it does not know, so two different files never collide', () => {
    expect(keyOf('https://cdn.test/play?id=1&token=abc&Signature=x')).toBe('url:https://cdn.test/play?id=1&token=abc');
    expect(keyOf('https://cdn.test/play?id=1')).not.toBe(keyOf('https://cdn.test/play?id=2'));
  });

  it('keeps a direct file pending on its URL key until a duration is known', () => {
    expect(resolveVideoIdentity(context({ sourceUrl: 'https://cdn.test/v.mp4', durationSec: Number.NaN }))).toEqual({
      kind: 'unknown',
      pendingKey: 'url:https://cdn.test/v.mp4',
    });
  });

  it('leaves a live direct file unknown', () => {
    const live = context({ sourceUrl: 'https://cdn.test/v.mp4', durationSec: Number.POSITIVE_INFINITY });
    expect(resolveVideoIdentity(live)).toEqual({ kind: 'unknown' });
  });
});

describe('resolveVideoIdentity: unidentifiable media', () => {
  it('leaves object-backed streams and non-http URLs unknown', () => {
    expect(resolveVideoIdentity(context({ sourceUrl: '' }))).toEqual({ kind: 'unknown' });
    expect(resolveVideoIdentity(context({ sourceUrl: 'data:video/mp4;base64,AAAA' }))).toEqual({ kind: 'unknown' });
  });
});

describe('resolveVideoIdentity: identity adapters', () => {
  const adapterNaming = (hosts: string[], reference: MediaReference | null): VideoIdentityAdapter => ({
    hosts,
    mediaReference: () => reference,
  });
  const MSE_SOURCE = 'blob:https://www.example.test/a';

  it('lets the first adapter on the page host or a parent domain name the media', () => {
    const adapters = [
      adapterNaming(['other.test'], { kind: 'stable', namespace: 'yt', id: '1' }),
      adapterNaming(['example.test'], { kind: 'stable', namespace: 'yt', id: '2' }),
    ];
    expect(resolveVideoIdentity(context({ sourceUrl: MSE_SOURCE }), adapters)).toEqual({
      kind: 'stable',
      key: 'yt:2',
      durationSec: 12.34,
    });
  });

  it('never applies an adapter on a host that only ends with its domain', () => {
    const adapter = adapterNaming(['ample.test'], { kind: 'stable', namespace: 'yt', id: '1' });
    expect(resolveVideoIdentity(context({ sourceUrl: MSE_SOURCE }), [adapter])).toHaveProperty('kind', 'local');
  });

  it('falls back to the generic rules when a matching adapter cannot name the media', () => {
    const identity = resolveVideoIdentity(context({ sourceUrl: 'https://cdn.test/v.mp4' }), [
      adapterNaming(['example.test'], null),
    ]);
    expect(identity).toEqual({ kind: 'stable', key: 'url:https://cdn.test/v.mp4', durationSec: 12.34 });
  });

  it('lets an adapter declare the media unidentifiable, keeping it out of the generic rules', () => {
    const ad = adapterNaming(['example.test'], { kind: 'unidentifiable' });
    expect(resolveVideoIdentity(context({ sourceUrl: 'https://cdn.test/ad.mp4' }), [ad])).toEqual({ kind: 'unknown' });
  });

  it("keeps an adapter's media pending on its key until a duration is known", () => {
    const adapter = adapterNaming(['example.test'], { kind: 'stable', namespace: 'vreddit', id: 'm1' });
    expect(resolveVideoIdentity(context({ sourceUrl: MSE_SOURCE, durationSec: Number.NaN }), [adapter])).toEqual({
      kind: 'unknown',
      pendingKey: 'vreddit:m1',
    });
  });

  it('identifies media only when its duration is within 1 s of the length the site reports', () => {
    const reporting = (expectedDurationSec: number) =>
      adapterNaming(['example.test'], { kind: 'stable', namespace: 'yt', id: 'abc', expectedDurationSec });
    expect(resolveVideoIdentity(context({ sourceUrl: MSE_SOURCE }), [reporting(13)])).toEqual({
      kind: 'stable',
      key: 'yt:abc',
      durationSec: 12.34,
    });
    expect(resolveVideoIdentity(context({ sourceUrl: MSE_SOURCE }), [reporting(30)])).toEqual({ kind: 'unknown' });
  });
});
