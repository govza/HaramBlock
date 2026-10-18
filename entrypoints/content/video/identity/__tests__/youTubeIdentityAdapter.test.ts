import { describe, expect, it } from 'vitest';

import { resolveVideoIdentity } from '@/entrypoints/content/video/identity/identityResolver';
import { HOOK_IDENTITY_ATTR, type HookIdentityClaim } from '@/utils/lookahead/protocol';

const OBJECT_URL = 'blob:https://www.youtube.com/7f1c';

const videoClaiming = (claim: HookIdentityClaim | string | null): HTMLVideoElement => {
  const raw = claim === null || typeof claim === 'string' ? claim : JSON.stringify(claim);
  return { getAttribute: (name: string) => (name === HOOK_IDENTITY_ATTR ? raw : null) } as HTMLVideoElement;
};

const identityOn = (pageHref: string, video: HTMLVideoElement, sourceUrl = OBJECT_URL) =>
  resolveVideoIdentity({ sourceUrl, pageHref, durationSec: 30.021, video });

const STABLE: HookIdentityClaim = {
  objectUrl: OBJECT_URL,
  identity: { kind: 'stable', key: 'yt:abc', durationSec: 30.021 },
};

describe('YouTube identity adapter', () => {
  it.each([
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/watch?v=abc&t=42&list=PL1&pp=x',
    'https://www.youtube.com/shorts/abc',
    'https://m.youtube.com/watch?v=abc',
    'https://www.youtube-nocookie.com/embed/abc?start=10',
  ])('identifies the video on %s by the video id the MSE hook established', pageHref => {
    expect(identityOn(pageHref, videoClaiming(STABLE))).toEqual({
      kind: 'stable',
      key: 'yt:abc',
      durationSec: 30.021,
    });
  });

  it('keeps a source unknown while the hook waits for its duration, naming the identity it expects', () => {
    const pending: HookIdentityClaim = { objectUrl: OBJECT_URL, identity: { kind: 'unknown', pendingKey: 'yt:abc' } };
    expect(identityOn('https://www.youtube.com/watch?v=abc', videoClaiming(pending))).toEqual({
      kind: 'unknown',
      pendingKey: 'yt:abc',
    });
  });

  it('never identifies a YouTube MSE source by its page, whatever the hook said or failed to say', () => {
    const watch = 'https://www.youtube.com/watch?v=abc';
    const unknown = { kind: 'unknown' };
    expect(identityOn(watch, videoClaiming(null))).toEqual(unknown);
    expect(identityOn(watch, videoClaiming({ ...STABLE, objectUrl: 'blob:https://www.youtube.com/old' }))).toEqual(
      unknown,
    );
    expect(identityOn(watch, videoClaiming('{not json'))).toEqual(unknown);
    expect(
      identityOn(
        watch,
        videoClaiming({ objectUrl: OBJECT_URL, identity: { kind: 'local', key: 'page:x', durationSec: 30 } }),
      ),
    ).toEqual(unknown);
    expect(
      identityOn(
        watch,
        videoClaiming({ objectUrl: OBJECT_URL, identity: { kind: 'stable', key: 'url:x', durationSec: 30 } }),
      ),
    ).toEqual(unknown);
  });

  it('leaves direct files on YouTube to the generic rules', () => {
    expect(
      identityOn('https://www.youtube.com/', videoClaiming(null), 'https://cdn.test/promo.mp4?Signature=1'),
    ).toEqual({ kind: 'stable', key: 'url:https://cdn.test/promo.mp4', durationSec: 30.021 });
  });

  it('ignores hook claims outside YouTube', () => {
    expect(identityOn('https://www.example.test/watch', videoClaiming(STABLE))).toEqual({
      kind: 'local',
      key: 'page:https://www.example.test/watch|d=300',
      durationSec: 30.021,
    });
  });
});
