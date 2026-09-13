type ImageSourceLike = Pick<HTMLImageElement, 'src' | 'currentSrc'> & {
  hasAttribute: (name: string) => boolean;
  parentElement: Element | null;
};

const usesCandidateSelection = (img: ImageSourceLike): boolean =>
  img.hasAttribute('srcset') || img.parentElement?.tagName === 'PICTURE';

/**
 * Firefox keeps `currentSrc` pointing at the previous request until the new
 * image's size is known, so right after a `src` swap it still reports the old
 * URL. Without candidate selection the reflected `src` is the truth.
 */
export const resolveImageSource = (img: ImageSourceLike): string => {
  if (usesCandidateSelection(img)) return img.currentSrc || img.src;
  return img.src || img.currentSrc;
};

const PLACEHOLDER_MAX_NATURAL_PX = 32;

/**
 * Low-quality placeholders (Google Images serves a 10 px thumbnail before the
 * real one) render at full layout size but carry no recognisable content;
 * inferring them only delays the images behind them in the queue.
 */
export const isPlaceholderResolution = (img: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>): boolean =>
  img.naturalWidth > 0 &&
  img.naturalHeight > 0 &&
  (img.naturalWidth < PLACEHOLDER_MAX_NATURAL_PX || img.naturalHeight < PLACEHOLDER_MAX_NATURAL_PX);
