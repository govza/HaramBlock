import type { IMaskingSettings } from '@/utils/types/host';

/** Maps blur intensity (1-100%) to blur pixels (1-30px) */
const BLUR_PX_MULTIPLIER = 0.3;

/** Minimum pixelation block size in pixels */
const MIN_PIXELATION_BLOCK = 8;

/** Maximum pixelation block size in pixels */
const MAX_PIXELATION_BLOCK = 150;

/** Brightness level for dark mode effect */
const DARK_MODE_BRIGHTNESS = 0.4;

/**
 * Calculate blur amount in pixels from blur intensity percentage.
 * Maps 1-100% to 1-30px (minimum 1px).
 */
export const calculateBlurPx = (blurIntensity: number): number => {
  return Math.max(1, Math.round(blurIntensity * BLUR_PX_MULTIPLIER));
};

/**
 * Calculate pixelation block size from pixelation scale percentage.
 * Uses quadratic ease-in curve: slow growth initially, accelerates toward 100%.
 */
export const calculatePixelationBlockSize = (pixelationScale: number): number => {
  const normalized = pixelationScale / 100;
  const curved = normalized * normalized;
  return MIN_PIXELATION_BLOCK + curved * (MAX_PIXELATION_BLOCK - MIN_PIXELATION_BLOCK);
};

/**
 * Build CSS filter string from masking settings.
 * Returns filter string like "blur(15px) grayscale(100%) brightness(0.4)".
 */
export const buildMaskingFilter = (masking: IMaskingSettings, includeBlur = true): string => {
  const filters: string[] = [];

  if (includeBlur) {
    const blurPx = calculateBlurPx(masking.blurIntensity);
    filters.push(`blur(${blurPx}px)`);
  }

  if (masking.grayscale) {
    filters.push('grayscale(100%)');
  }

  if (masking.dark) {
    filters.push(`brightness(${DARK_MODE_BRIGHTNESS})`);
  }

  return filters.join(' ');
};

/**
 * Build canvas tint filter string (for mask overlays).
 * Only includes grayscale and dark effects, not blur.
 */
export const buildCanvasTintFilter = (masking: IMaskingSettings): string => {
  return buildMaskingFilter(masking, false);
};
