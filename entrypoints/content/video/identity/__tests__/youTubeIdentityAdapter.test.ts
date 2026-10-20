import { describe, expect, it } from 'vitest';

import { resolveVideoIdentity } from '@/entrypoints/content/video/identity/identityResolver';
import { HOOK_IDENTITY_ATTR, type HookIdentityClaim } from '@/utils/lookahead/protocol';

const OBJECT_URL = 'blob:https://www.youtube.com/7f1c';

const videoClaiming = (claim: HookIdentityClaim | string | null): HTMLVideoElement => {
  const raw = claim === null || typeof claim === 'string' ? claim : JSON.stringify(claim);
  return { getAttribute: (name: string) => (name === HOOK_IDENTITY_ATTR ? raw : null) } as HTMLVideoElement;
};

const identityOn = (pageHref: string, video: HTMLVideoElement, sourceUrl = OBJECT_URL, durationSec = 30.021) =>
  resolveVideoIdentity({ sourceUrl, pageHref, durationSec, video });

const CLAIM: HookIdentityClaim = {
  objectUrl: OBJECT_URL,
  reference: { kind: 'stable', namespace: 'yt', id: 'abc', expectedDurationSec: 30 },
};

describe('YouTube identity adapter', () => {
  it.each([
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/watch?v=abc&t=42&list=PL1&pp=x',
    'https://www.youtube.com/shorts/abc',
    'https://m.youtube.com/watch?v=abc',
    'https://www.youtube-nocookie.com/embed/abc?start=10',
  ])('identifies the video on %s by the video id the MSE hook established', pageHref => {
    expect(identityOn(pageHref, videoClaiming(CLAIM))).toEqual({
      kind: 'stable',
      key: 'yt:abc',
      durationSec: 30.021,
    });
  });

  it('keeps a source pending on the claimed video until its duration is known', () => {
    expect(identityOn('https://www.youtube.com/watch?v=abc', videoClaiming(CLAIM), OBJECT_URL, Number.NaN)).toEqual({
      kind: 'unknown',
      pendingKey: 'yt:abc',
    });
  });

  it("keeps a source unknown when its duration is not the claimed video's", () => {
    expect(identityOn('https://www.youtube.com/watch?v=abc', videoClaiming(CLAIM), OBJECT_URL, 15.2)).toEqual({
      kind: 'unknown',
    });
  });

  it('never identifies a YouTube MSE source by its page, whatever the hook said or failed to say', () => {
    const watch = 'https://www.youtube.com/watch?v=abc';
    const unknown = { kind: 'unknown' };
    expect(identityOn(watch, videoClaiming(null))).toEqual(unknown);
    expect(identityOn(watch, videoClaiming({ ...CLAIM, objectUrl: 'blob:https://www.youtube.com/old' }))).toEqual(
      unknown,
    );
    expect(identityOn(watch, videoClaiming('{not json'))).toEqual(unknown);
    expect(identityOn(watch, videoClaiming({ objectUrl: OBJECT_URL, reference: { kind: 'unidentifiable' } }))).toEqual(
      unknown,
    );
    expect(identityOn(watch, videoClaiming({ objectUrl: OBJECT_URL, reference: { kind: 'local' } }))).toEqual(unknown);
    expect(
      identityOn(
        watch,
        videoClaiming({ objectUrl: OBJECT_URL, reference: { kind: 'stable', namespace: 'url', id: 'x' } }),
      ),
    ).toEqual(unknown);
  });

  it('leaves direct files on YouTube to the generic rules', () => {
    expect(
      identityOn('https://www.youtube.com/', videoClaiming(null), 'https://cdn.test/promo.mp4?Signature=1'),
    ).toEqual({ kind: 'stable', key: 'url:https://cdn.test/promo.mp4', durationSec: 30.021 });
  });

  it('ignores hook claims outside YouTube', () => {
    expect(identityOn('https://www.example.test/watch', videoClaiming(CLAIM))).toEqual({
      kind: 'local',
      key: 'page:https://www.example.test/watch|d=300',
      durationSec: 30.021,
    });
  });
});
