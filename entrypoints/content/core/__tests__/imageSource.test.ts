import { describe, expect, it } from 'vitest';

import { isPlaceholderResolution, resolveImageSource } from '@/entrypoints/content/core/imageSource';

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

describe('isPlaceholderResolution', () => {
  it('flags a 10 px Google placeholder', () => {
    expect(isPlaceholderResolution({ naturalWidth: 10, naturalHeight: 13 })).toBe(true);
  });

  it('flags a strip whose smaller side is tiny', () => {
    expect(isPlaceholderResolution({ naturalWidth: 400, naturalHeight: 16 })).toBe(true);
  });

  it('does not flag an undecoded image', () => {
    expect(isPlaceholderResolution({ naturalWidth: 0, naturalHeight: 0 })).toBe(false);
  });

  it('does not flag a regular thumbnail', () => {
    expect(isPlaceholderResolution({ naturalWidth: 160, naturalHeight: 200 })).toBe(false);
  });
});
