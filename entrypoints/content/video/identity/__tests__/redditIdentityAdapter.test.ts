// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { resolveVideoIdentity } from '@/entrypoints/content/video/identity/identityResolver';

import type { VideoIdentity } from '@/utils/types';

const FEED_PAGE = 'https://www.reddit.com/r/aww/';
const POST_PAGE = 'https://www.reddit.com/r/aww/comments/1x63bfs/a_cat/';
const MEDIA_ID = 'd77amxm51ivh1';
const DURATION_SEC = 26.878;

interface PlayerFixture {
  src: string;
  preview?: string;
  captionUrl?: string;
  gif?: boolean;
}

interface MountedPlayer {
  player: HTMLElement;
  shadowVideo: HTMLVideoElement;
  previewVideo: HTMLVideoElement;
}

const feedPlayer = (id: string, signature: string): PlayerFixture => ({
  src: `https://v.redd.it/${id}/HLSPlaylist.m3u8?f=hd%2CsubsAll%2ChlsSpecOrder&v=1&a=${signature}`,
  preview: `https://v.redd.it/${id}/CMAF_96.mp4`,
  captionUrl: `https://v.redd.it/${id}/wh_ben_en.vtt`,
});

const createPlayer = ({ src, preview, captionUrl, gif }: PlayerFixture): MountedPlayer => {
  const player = document.createElement('shreddit-player');
  player.setAttribute('src', src);
  if (preview) player.setAttribute('preview', preview);
  if (captionUrl) player.setAttribute('caption-url', captionUrl);
  if (gif) player.setAttribute('gif', '');
  const shadowVideo = document.createElement('video');
  player.attachShadow({ mode: 'open' }).append(shadowVideo);
  const previewLazy = document.createElement('shreddit-preview-video-lazy');
  const progressBar = document.createElement('shreddit-progress-bar');
  const mediaUi = document.createElement('shreddit-media-ui');
  const previewVideo = document.createElement('video');
  mediaUi.append(previewVideo);
  progressBar.append(mediaUi);
  previewLazy.append(progressBar);
  player.append(previewLazy);
  return { player, shadowVideo, previewVideo };
};

const mountInPost = (fixture: PlayerFixture, contentHref: string): MountedPlayer => {
  const post = document.createElement('shreddit-post');
  post.setAttribute('content-href', contentHref);
  post.setAttribute('post-type', 'video');
  const mounted = createPlayer(fixture);
  post.append(mounted.player);
  document.body.append(post);
  return mounted;
};

const mountAd = (fixture: PlayerFixture): MountedPlayer => {
  const mounted = createPlayer(fixture);
  document.body.append(mounted.player);
  return mounted;
};

const identify = (
  video: HTMLVideoElement,
  sourceUrl: string,
  pageHref = FEED_PAGE,
  durationSec = DURATION_SEC,
): VideoIdentity => resolveVideoIdentity({ sourceUrl, pageHref, durationSec, video });

const stableReddit = (key: string): VideoIdentity => ({ kind: 'stable', key, durationSec: DURATION_SEC });

const packagedMediaSrc = (id: string, signature: string) =>
  `https://packaged-media.redd.it/${id}/pb/m2-res_1280p.mp4?m=DASHPlaylist.mpd&v=1&e=1794918555&s=${signature}`;

afterEach(() => {
  document.body.replaceChildren();
});

describe('Reddit video identity', () => {
  it('resolves the same vreddit id for a video in the feed and on its post page', () => {
    const feed = mountInPost(feedPlayer(MEDIA_ID, '1794918555,feedsig'), `https://v.redd.it/${MEDIA_ID}`);
    const feedIdentity = identify(feed.shadowVideo, 'blob:https://www.reddit.com/0b1c', FEED_PAGE);
    document.body.replaceChildren();

    const post = mountInPost(feedPlayer(MEDIA_ID, '1794918570,postsig'), `https://v.redd.it/${MEDIA_ID}`);
    const postIdentity = identify(post.shadowVideo, packagedMediaSrc(MEDIA_ID, 'postsig'), POST_PAGE);

    expect(feedIdentity).toEqual(stableReddit(`vreddit:${MEDIA_ID}`));
    expect(postIdentity).toEqual(feedIdentity);
  });

  it('resolves both videos of one player to the same identity', () => {
    const { shadowVideo, previewVideo } = mountInPost(feedPlayer(MEDIA_ID, '1,sig'), `https://v.redd.it/${MEDIA_ID}`);

    expect(identify(shadowVideo, packagedMediaSrc(MEDIA_ID, 'sig'))).toEqual(stableReddit(`vreddit:${MEDIA_ID}`));
    expect(identify(previewVideo, `https://v.redd.it/${MEDIA_ID}/CMAF_96.mp4`)).toEqual(
      stableReddit(`vreddit:${MEDIA_ID}`),
    );
  });

  it('resolves a feed ad, which has no post, to its own media id', () => {
    const ad = mountAd({
      ...feedPlayer('adm3d1a0000x1', '1,adsig'),
      captionUrl: 'https://v.redd.it/adm3d1a0000x1/advertiser_en.vtt',
    });
    mountInPost(feedPlayer(MEDIA_ID, '1,sig'), `https://v.redd.it/${MEDIA_ID}`);

    expect(identify(ad.shadowVideo, 'blob:https://www.reddit.com/ad')).toEqual(stableReddit('vreddit:adm3d1a0000x1'));
  });

  it('identifies each video on a page by its own player, not the first player on the page', () => {
    mountInPost({ src: 'https://external-preview.redd.it/imageonly.jpeg?s=x' }, 'https://i.redd.it/imageonly.jpeg');
    mountInPost(feedPlayer(MEDIA_ID, '1,sig'), `https://v.redd.it/${MEDIA_ID}`);
    const recommended = mountInPost(feedPlayer('buou13i5euvh1', '1,sig'), 'https://v.redd.it/buou13i5euvh1');

    expect(identify(recommended.shadowVideo, 'blob:https://www.reddit.com/r', POST_PAGE)).toEqual(
      stableReddit('vreddit:buou13i5euvh1'),
    );
  });

  it('resolves one identity whatever the signed query on the source', () => {
    const { shadowVideo } = mountInPost(feedPlayer(MEDIA_ID, '1,sig'), `https://v.redd.it/${MEDIA_ID}`);

    expect(identify(shadowVideo, packagedMediaSrc(MEDIA_ID, 'first'))).toEqual(
      identify(shadowVideo, packagedMediaSrc(MEDIA_ID, 'second')),
    );
    expect(identify(shadowVideo, `https://v.redd.it/${MEDIA_ID}/CMAF_480.mp4?source=fallback&e=1&s=a`)).toEqual(
      stableReddit(`vreddit:${MEDIA_ID}`),
    );
  });

  it('falls back to the post content link when the player carries no media URL', () => {
    const { shadowVideo } = mountInPost({ src: '' }, `https://v.redd.it/${MEDIA_ID}`);

    expect(identify(shadowVideo, 'blob:https://www.reddit.com/x')).toEqual(stableReddit(`vreddit:${MEDIA_ID}`));
  });

  it('identifies a comment GIF by its external-preview path hash', () => {
    const gifSrc = (signature: string) =>
      `https://external-preview.redd.it/aB3-dEf_gH.gif?width=320&format=mp4&s=${signature}`;
    const gif = mountAd({ src: gifSrc('one'), gif: true });

    expect(identify(gif.shadowVideo, gifSrc('one'))).toEqual(stableReddit('redditpreview:aB3-dEf_gH'));
    expect(identify(gif.shadowVideo, gifSrc('two'))).toEqual(stableReddit('redditpreview:aB3-dEf_gH'));
  });

  it('keeps unidentifiable Reddit media unknown instead of keying it by URL', () => {
    const { shadowVideo } = mountAd({ src: '' });

    expect(identify(shadowVideo, 'https://cdn.example.test/clip.mp4')).toEqual({ kind: 'unknown' });
  });

  it('keeps Reddit media pending on its media id until a duration is known', () => {
    const { shadowVideo } = mountInPost(feedPlayer(MEDIA_ID, '1,sig'), `https://v.redd.it/${MEDIA_ID}`);

    expect(identify(shadowVideo, 'blob:https://www.reddit.com/x', FEED_PAGE, Number.NaN)).toEqual({
      kind: 'unknown',
      pendingKey: `vreddit:${MEDIA_ID}`,
    });
  });

  it('applies on old.reddit and leaves other sites to the generic rules', () => {
    expect(
      identify(document.createElement('video'), `https://v.redd.it/${MEDIA_ID}/CMAF_96.mp4`, 'https://old.reddit.com/'),
    ).toEqual(stableReddit(`vreddit:${MEDIA_ID}`));
    expect(
      identify(document.createElement('video'), `https://v.redd.it/${MEDIA_ID}/CMAF_96.mp4`, 'https://notreddit.com/'),
    ).toEqual(stableReddit(`url:https://v.redd.it/${MEDIA_ID}/CMAF_96.mp4`));
  });
});
