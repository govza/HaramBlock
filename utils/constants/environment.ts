// Browser detection (build-time constant)
export const IS_CHROME = import.meta.env.CHROME === true;

// =============================================================================
// Image Transfer Configuration
// =============================================================================
// Architecture separation:
// - Chrome: MessageChannel with bitmap (zero-copy), fallback to URL only (never blob)
// - Firefox: blob primary, fallback to URL (never bitmap - no MessageChannel support)

// Chrome: bitmap primary, url fallback (NEVER blob - that defeats MessageChannel purpose)
type ChromeImageTransferKind = 'bitmap' | 'url';
// Firefox: blob primary, url fallback (NEVER bitmap - no MessageChannel support)
type FirefoxImageTransferKind = 'blob' | 'url';

// Union for type-safe cross-browser code
export type ImageTransferKind = ChromeImageTransferKind | FirefoxImageTransferKind;

// Fallback kind (same for both browsers: always 'url')
export type ImageFallbackKind = 'url';

// Valid kinds per browser (for runtime validation)
const CHROME_IMAGE_KINDS: readonly ChromeImageTransferKind[] = ['bitmap', 'url'];
const FIREFOX_IMAGE_KINDS: readonly FirefoxImageTransferKind[] = ['blob', 'url'];

export const VALID_IMAGE_TRANSFER_KINDS: readonly ImageTransferKind[] = IS_CHROME
  ? CHROME_IMAGE_KINDS
  : FIREFOX_IMAGE_KINDS;

// Fallback kind (ensures no blob on Chrome, no bitmap on Firefox)
export const IMAGE_FALLBACK_KIND: ImageFallbackKind = 'url';

/**
 * Whether MessageChannel transport is used (Chrome only).
 * Required for 'bitmap' transfer kind (zero-copy ImageBitmap).
 */
export const USE_MESSAGE_CHANNEL = IS_CHROME;

/**
 * Image transfer kind for inference payloads.
 * - Chrome: 'bitmap' via MessageChannel (zero-copy), falls back to 'url'
 * - Firefox: 'blob' via structured clone, falls back to 'url'
 */
export const IMAGE_TRANSFER_KIND: ImageTransferKind = IS_CHROME ? 'bitmap' : 'blob';

// Validate at module load time - catches invalid config immediately
if (!VALID_IMAGE_TRANSFER_KINDS.includes(IMAGE_TRANSFER_KIND)) {
  throw new Error(
    `Invalid IMAGE_TRANSFER_KIND '${IMAGE_TRANSFER_KIND}' for ${IS_CHROME ? 'Chrome' : 'Firefox'}. ` +
      `Valid options: ${VALID_IMAGE_TRANSFER_KINDS.join(', ')}`,
  );
}

// =============================================================================
// Video Frame Transfer Configuration
// =============================================================================
// Video frames cannot use URL (generated in content script, not fetchable by background)
// Architecture separation:
// - Chrome: MessageChannel with bitmap (zero-copy), NO fallback (skip frame if unavailable)
// - Firefox: blob only via structured clone (no MessageChannel support)

// Chrome: bitmap only (NEVER blob - no fallback for video frames, skip if MessageChannel down)
type ChromeVideoFrameTransferKind = 'bitmap';
// Firefox: blob only (NEVER bitmap - no MessageChannel support)
type FirefoxVideoFrameTransferKind = 'blob';

// Union for type-safe cross-browser code
export type VideoFrameTransferKind = ChromeVideoFrameTransferKind | FirefoxVideoFrameTransferKind;

// Valid kinds per browser (for runtime validation)
const CHROME_VIDEO_KINDS: readonly ChromeVideoFrameTransferKind[] = ['bitmap'];
const FIREFOX_VIDEO_KINDS: readonly FirefoxVideoFrameTransferKind[] = ['blob'];

export const VALID_VIDEO_TRANSFER_KINDS: readonly VideoFrameTransferKind[] = IS_CHROME
  ? CHROME_VIDEO_KINDS
  : FIREFOX_VIDEO_KINDS;

/**
 * Video frame transfer kind for inference payloads.
 * - Chrome: 'bitmap' via MessageChannel (zero-copy), no fallback (skip if unavailable)
 * - Firefox: 'blob' via structured clone (compressed WebP)
 */
export const VIDEO_FRAME_TRANSFER_KIND: VideoFrameTransferKind = IS_CHROME ? 'bitmap' : 'blob';
