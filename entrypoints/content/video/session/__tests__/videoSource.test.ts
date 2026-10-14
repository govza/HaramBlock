import { describe, expect, it } from 'vitest';

import { compareSources, type ResolvedVideoSource } from '@/entrypoints/content/video/session/videoSource';

const urlSource = (url: string, cacheKey = url): ResolvedVideoSource => ({ srcObject: null, url, cacheKey });
const streamSource = (stream: MediaStream): ResolvedVideoSource => ({ srcObject: stream, url: '', cacheKey: '' });

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

  it('treats a new blob URL with the same cache key as the same media', () => {
    const pageKey = 'https://www.youtube.com/watch?v=1';
    expect(
      compareSources(
        urlSource('blob:https://www.youtube.com/a', pageKey),
        urlSource('blob:https://www.youtube.com/b', pageKey),
      ),
    ).toBe('sameMedia');
  });

  it('treats URLs with different cache keys as different media', () => {
    expect(compareSources(urlSource('https://cdn.test/a.mp4'), urlSource('https://cdn.test/b.mp4'))).toBe('different');
  });

  it('never continues media without a cache key', () => {
    expect(compareSources(urlSource('https://cdn.test/a.mp4', ''), urlSource('https://cdn.test/b.mp4', ''))).toBe(
      'different',
    );
  });

  it('treats a switch between a stream and a URL as different media', () => {
    const stream = {} as MediaStream;
    expect(compareSources(streamSource(stream), urlSource('https://cdn.test/a.mp4'))).toBe('different');
    expect(compareSources(urlSource('https://cdn.test/a.mp4'), streamSource(stream))).toBe('different');
  });
});
