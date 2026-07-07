// External test fixture URL - tests depend on this site being available.
// If tests fail due to network issues, verify haramblock.com is accessible.
export const GALLERY_BASE_URL = 'https://haramblock.com/gallery/basic';

export const INFERENCE_TIMEOUT = 80_000;

export const Selectors = {
  /** The extension-owned overlay layer host; mask slots are its light-DOM children (no shadow root) */
  OVERLAY_HOST: 'haramblock-overlay-layer',
  /** The always-on-top UI host; the eye toggle lives in its shadow root */
  UI_HOST: 'haramblock-overlay-ui',
  SEGMENT_OVERLAY: '[data-overlay-slot="image-mask"]',
  BLACKLIST_ATTR: 'data-haramblock-blacklist',
  GALLERY_IMAGE: 'main img',
  EYE_TOGGLE: '.haramblock-eye-toggle',
} as const;

export const GalleryMode = {
  SAFE: 'sf-neutral',
  NOT_SAFE: 'nsf-female',
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
  // Uncovered: with overlay=true the gallery's protective cover sits over the images
  // and whether a mask paints above or below it is decided purely by z-index stacking
  // (occlusion detection no longer exists), so mask visuals are only assertable on
  // uncovered images.
  overlay: false,
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
