// External test fixture URL - tests depend on this site being available.
// If tests fail due to network issues, verify haramblock.com is accessible.
export const GALLERY_BASE_URL = 'https://haramblock.com/gallery/basic';

export const INFERENCE_TIMEOUT = 60000;

export const Selectors = {
  SEGMENT_OVERLAY: '[data-mask-overlay="unified-mask-overlay"]',
  BBOX_OVERLAY: '.haramblock-blur-box',
  BLACKLIST_ATTR: 'data-haramblock-blacklist',
  GALLERY_IMAGE: 'main img',
} as const;

export const GalleryMode = {
  SAFE: 'safe',
  NOT_SAFE: 'not-safe',
} as const;

export const GallerySize = {
  ICON: 'icon',
  SMALL: 'small',
  MEDIUM: 'medium',
  LARGE: 'large',
  LARGE_X2: 'largex2',
  ORIGINAL: 'original',
} as const;

export type GalleryModeType = (typeof GalleryMode)[keyof typeof GalleryMode];
export type GallerySizeType = (typeof GallerySize)[keyof typeof GallerySize];

export interface GalleryParams {
  mode: GalleryModeType;
  count: number; // 1-100
  overlay: boolean;
  naturalized: boolean;
  size: GallerySizeType;
}

export const DEFAULT_GALLERY_PARAMS: GalleryParams = {
  mode: GalleryMode.NOT_SAFE,
  count: 25,
  overlay: true,
  naturalized: false,
  size: GallerySize.MEDIUM,
};

export const buildGalleryUrl = (params: Partial<GalleryParams> = {}): string => {
  const mergedParams = { ...DEFAULT_GALLERY_PARAMS, ...params };
  const count = Math.min(100, Math.max(1, mergedParams.count));
  const searchParams = new URLSearchParams({
    mode: mergedParams.mode,
    count: String(count),
    overlay: String(mergedParams.overlay),
    naturalized: String(mergedParams.naturalized),
    size: mergedParams.size,
  });
  return `${GALLERY_BASE_URL}?${searchParams.toString()}`;
};
