import { describe, expect, it } from 'vitest';

import { compareSources, type ResolvedVideoSource } from '@/entrypoints/content/video/session/videoSource';
import { UNKNOWN_VIDEO_IDENTITY, type VideoIdentity } from '@/utils/videoIdentity';

const local = (key: string): VideoIdentity => ({ kind: 'local', key, durationSec: 60 });
const stable = (key: string): VideoIdentity => ({ kind: 'stable', key, durationSec: 60 });

const urlSource = (url: string, identity: VideoIdentity = stable(`url:${url}`)): ResolvedVideoSource => ({
  srcObject: null,
  url,
  identity,
});
const streamSource = (stream: MediaStream): ResolvedVideoSource => ({
  srcObject: stream,
  url: '',
  identity: UNKNOWN_VIDEO_IDENTITY,
});

describe('compareSources', () => {
  it('treats an identical URL as the same source', () => {
    expect(compareSources(urlSource('https://cdn.test/a.mp4'), urlSource('https://cdn.test/a.mp4'))).toBe('sameSource');
  });

  it('treats the same stream object as the same source', () => {
    const stream = {} as MediaStream;
    expect(compareSources(streamSource(stream), streamSource(stream))).toBe('sameSource');
  });

  it('treats a different stream object as different media', () => {
    expect(compareSources(streamSource({} as MediaStream), streamSource({} as MediaStream))).toBe('different');
  });

  it('treats a new blob URL with the same identity as the same media', () => {
    const page = local('page:https://www.example.test/watch|d=600');
    expect(
      compareSources(
        urlSource('blob:https://www.example.test/a', page),
        urlSource('blob:https://www.example.test/b', page),
      ),
    ).toBe('sameMedia');
  });

  it('treats a direct file whose signed tokens rotated as the same media', () => {
    const file = stable('url:https://cdn.test/a.mp4');
    expect(
      compareSources(
        urlSource('https://cdn.test/a.mp4?Signature=1', file),
        urlSource('https://cdn.test/a.mp4?Signature=2', file),
      ),
    ).toBe('sameMedia');
  });

  it('treats sources with different identities as different media', () => {
    expect(compareSources(urlSource('https://cdn.test/a.mp4'), urlSource('https://cdn.test/b.mp4'))).toBe('different');
  });

  it('never lets an unknown source continue another source, nor be continued', () => {
    const content = local('page:https://www.example.test/watch|d=600');
    const ad = urlSource('blob:https://www.example.test/ad', UNKNOWN_VIDEO_IDENTITY);
    expect(compareSources(urlSource('blob:https://www.example.test/a', content), ad)).toBe('different');
    expect(compareSources(ad, urlSource('blob:https://www.example.test/a', content))).toBe('different');
    expect(compareSources(ad, urlSource('blob:https://www.example.test/b', UNKNOWN_VIDEO_IDENTITY))).toBe('different');
  });

  it('lets a new source awaiting the identity of the media playing so far wait to continue it', () => {
    const video = stable('yt:abc');
    const qualitySwitch = urlSource('blob:https://www.youtube.com/b', { kind: 'unknown', pendingKey: 'yt:abc' });
    expect(compareSources(urlSource('blob:https://www.youtube.com/a', video), qualitySwitch)).toBe('pendingSameMedia');
  });

  it('never waits on a new source expecting another identity, or on media that was never identified', () => {
    const autoplayNext = urlSource('blob:https://www.youtube.com/b', { kind: 'unknown', pendingKey: 'yt:next' });
    expect(compareSources(urlSource('blob:https://www.youtube.com/a', stable('yt:abc')), autoplayNext)).toBe(
      'different',
    );
    const unidentified = urlSource('blob:https://www.youtube.com/a', UNKNOWN_VIDEO_IDENTITY);
    const pending = urlSource('blob:https://www.youtube.com/b', { kind: 'unknown', pendingKey: 'yt:abc' });
    expect(compareSources(unidentified, pending)).toBe('different');
  });

  it('treats a switch between a stream and a URL as different media', () => {
    const stream = {} as MediaStream;
    expect(compareSources(streamSource(stream), urlSource('https://cdn.test/a.mp4'))).toBe('different');
    expect(compareSources(urlSource('https://cdn.test/a.mp4'), streamSource(stream))).toBe('different');
  });
});
