import { describe, expect, it } from 'vitest';

import { resolveImageSource } from '@/entrypoints/content/core/imageSource';

const fakeImage = (fields: { src: string; currentSrc: string; srcset?: boolean; inPicture?: boolean }) => ({
  src: fields.src,
  currentSrc: fields.currentSrc,
  hasAttribute: (name: string) => name === 'srcset' && Boolean(fields.srcset),
  parentElement: fields.inPicture ? ({ tagName: 'PICTURE' } as Element) : ({ tagName: 'DIV' } as Element),
});

describe('resolveImageSource', () => {
  it('prefers the reflected src when currentSrc still points at the previous request', () => {
    const img = fakeImage({ src: 'https://x/full', currentSrc: 'https://x/placeholder' });
    expect(resolveImageSource(img)).toBe('https://x/full');
  });

  it('falls back to currentSrc when src is empty', () => {
    const img = fakeImage({ src: '', currentSrc: 'https://x/from-picture' });
    expect(resolveImageSource(img)).toBe('https://x/from-picture');
  });

  it('keeps currentSrc for srcset candidates', () => {
    const img = fakeImage({ src: 'https://x/fallback', currentSrc: 'https://x/2x', srcset: true });
    expect(resolveImageSource(img)).toBe('https://x/2x');
  });

  it('keeps currentSrc for picture sources', () => {
    const img = fakeImage({ src: 'https://x/fallback', currentSrc: 'https://x/webp', inPicture: true });
    expect(resolveImageSource(img)).toBe('https://x/webp');
  });
});
