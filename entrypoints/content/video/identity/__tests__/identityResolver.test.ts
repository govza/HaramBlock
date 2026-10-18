import { describe, expect, it } from 'vitest';

import {
  resolveVideoIdentity,
  type VideoIdentityAdapter,
  type VideoIdentityContext,
} from '@/entrypoints/content/video/identity/identityResolver';

const PAGE = 'https://www.example.test/feed?tab=new#comments';

const context = (overrides: Partial<VideoIdentityContext>): VideoIdentityContext => ({
  sourceUrl: '',
  pageHref: PAGE,
  durationSec: 12.34,
  ...overrides,
});

describe('resolveVideoIdentity: MSE sources', () => {
  it('identifies an MSE source locally by its page without fragment and its duration in 100 ms', () => {
    expect(resolveVideoIdentity(context({ sourceUrl: 'blob:https://www.example.test/1a2b' }))).toEqual({
      kind: 'local',
      key: 'page:https://www.example.test/feed?tab=new|d=123',
      durationSec: 12.34,
    });
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

  it('leaves a direct file unknown until a duration is known', () => {
    expect(resolveVideoIdentity(context({ sourceUrl: 'https://cdn.test/v.mp4', durationSec: Number.NaN }))).toEqual({
      kind: 'unknown',
    });
  });
});

describe('resolveVideoIdentity: unidentifiable media', () => {
  it('leaves object-backed streams and non-http URLs unknown', () => {
    expect(resolveVideoIdentity(context({ sourceUrl: '' }))).toEqual({ kind: 'unknown' });
    expect(resolveVideoIdentity(context({ sourceUrl: 'data:video/mp4;base64,AAAA' }))).toEqual({ kind: 'unknown' });
  });
});

describe('resolveVideoIdentity: identity adapters', () => {
  const stableAdapter = (hostname: string, key: string): VideoIdentityAdapter => ({
    matches: location => location.hostname === hostname,
    resolve: ({ durationSec }) => ({ kind: 'stable', key, durationSec }),
  });

  it('lets the first adapter matching the page location identify the video', () => {
    const adapters = [stableAdapter('other.test', 'x:1'), stableAdapter('www.example.test', 'x:2')];
    const identity = resolveVideoIdentity(context({ sourceUrl: 'blob:https://www.example.test/a' }), adapters);
    expect(identity).toEqual({ kind: 'stable', key: 'x:2', durationSec: 12.34 });
  });

  it('falls back to the generic rules when a matching adapter cannot identify the video', () => {
    const declining: VideoIdentityAdapter = { matches: () => true, resolve: () => null };
    const identity = resolveVideoIdentity(context({ sourceUrl: 'https://cdn.test/v.mp4' }), [declining]);
    expect(identity).toEqual({ kind: 'stable', key: 'url:https://cdn.test/v.mp4', durationSec: 12.34 });
  });

  it('lets an adapter declare a video unknown, keeping it out of the generic rules', () => {
    const ad: VideoIdentityAdapter = { matches: () => true, resolve: () => ({ kind: 'unknown' }) };
    expect(resolveVideoIdentity(context({ sourceUrl: 'https://cdn.test/ad.mp4' }), [ad])).toEqual({ kind: 'unknown' });
  });
});
