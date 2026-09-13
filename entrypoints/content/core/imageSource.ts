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
