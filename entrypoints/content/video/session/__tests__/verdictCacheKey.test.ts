import { describe, expect, it } from 'vitest';

import { toVerdictCacheKey, withoutFragment } from '@/entrypoints/content/video/session/verdictCacheKey';

describe('toVerdictCacheKey', () => {
  it('uses the media URL for file-backed sources', () => {
    expect(toVerdictCacheKey('https://cdn.test/clip.mp4', 'https://page.test/watch')).toBe('https://cdn.test/clip.mp4');
  });

  it('uses the page URL without fragment for blob-backed (MSE) sources', () => {
    expect(
      toVerdictCacheKey('blob:https://www.youtube.com/abc', 'https://www.youtube.com/watch?v=1&t=42s&list=PL1#top'),
    ).toBe('https://www.youtube.com/watch?v=1&t=42s&list=PL1');
  });

  it('is empty for object-backed sources', () => {
    expect(toVerdictCacheKey('', 'https://page.test')).toBe('');
  });
});

describe('withoutFragment', () => {
  it('drops only the fragment', () => {
    expect(withoutFragment('https://a.test/p?v=1&q=2#h')).toBe('https://a.test/p?v=1&q=2');
  });

  it('returns fragment-less input unchanged', () => {
    expect(withoutFragment('https://a.test/p?v=1')).toBe('https://a.test/p?v=1');
  });

  it('returns unparsable input unchanged', () => {
    expect(withoutFragment('not a url')).toBe('not a url');
  });
});
