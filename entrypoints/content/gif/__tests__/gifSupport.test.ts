import { describe, expect, it } from 'vitest';

import { isGifCandidate } from '@/entrypoints/content/gif/gifSupport';

describe('isGifCandidate', () => {
  it('matches .gif URLs regardless of query or hash', () => {
    expect(isGifCandidate('https://example.com/cat.gif')).toBe(true);
    expect(isGifCandidate('https://example.com/cat.GIF')).toBe(true);
    expect(isGifCandidate('https://example.com/cat.gif?v=2')).toBe(true);
    expect(isGifCandidate('https://example.com/cat.gif#frag')).toBe(true);
  });

  it('matches when the content-type hint is image/gif', () => {
    expect(isGifCandidate('https://cdn.example.com/asset/12345', 'image/gif')).toBe(true);
    expect(isGifCandidate('https://cdn.example.com/asset/12345', 'IMAGE/GIF')).toBe(true);
  });

  it('does not match non-GIF images', () => {
    expect(isGifCandidate('https://example.com/photo.jpg')).toBe(false);
    expect(isGifCandidate('https://example.com/photo.png', 'image/png')).toBe(false);
    expect(isGifCandidate('https://example.com/giftshop/banner.png')).toBe(false);
  });

  it('ignores a missing content-type hint', () => {
    expect(isGifCandidate('https://example.com/photo.webp', null)).toBe(false);
    expect(isGifCandidate('https://example.com/photo.webp', undefined)).toBe(false);
  });
});
