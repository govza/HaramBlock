type ImageSourceLike = Pick<HTMLImageElement, 'src' | 'currentSrc'> & {
  hasAttribute: (name: string) => boolean;
  parentElement: Element | null;
};

const usesCandidateSelection = (img: ImageSourceLike): boolean =>
  img.hasAttribute('srcset') || img.parentElement?.tagName === 'PICTURE';

export const resolveImageSource = (img: ImageSourceLike): string => {
  if (usesCandidateSelection(img)) return img.currentSrc || img.src;
  return img.src || img.currentSrc;
};

export type NaturalSize = { width: number; height: number };

export const isPlaceholderResolution = (
  img: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>,
  maxNatural: NaturalSize,
): boolean =>
  img.naturalWidth > 0 &&
  img.naturalHeight > 0 &&
  img.naturalWidth < maxNatural.width &&
  img.naturalHeight < maxNatural.height;
