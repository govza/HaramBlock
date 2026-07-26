/** Data attribute marking an element as blacklisted (blocked by policy or forced visibility) */
export const BLACKLIST_ATTR = 'data-haramblock-blacklist';

/** CSS class for initial blur while waiting for AI analysis */
export const BLUR_CLASS = 'haramblock-initial-blur';

/** Data attributes for processed status */
export const PROCESSED_SAFE_ATTR = 'data-haramblock-processed-safe';
export const PROCESSED_UNSAFE_ATTR = 'data-haramblock-processed-unsafe';
export const PROCESSED_SKIPPED_ATTR = 'data-haramblock-processed-skipped';

/**
 * Marker attributes on overlay elements injected next to media. The
 * predecessor sweep (lifecycle/predecessorSweep.ts) removes leftovers by
 * these markers, so they must stay in sync with the injecting modules.
 */
export const DVR_OVERLAY_ATTR = 'data-video-dvr-player';
export const VIDEO_MASK_OVERLAY_ATTR = 'data-video-mask-overlay';
export const IMAGE_MASK_OVERLAY_ATTR = 'data-mask-overlay';
export const GIF_MASK_OVERLAY_ATTR = 'data-gif-mask-player';
