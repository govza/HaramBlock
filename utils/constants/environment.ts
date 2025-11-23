// Browser detection (build-time constant)
export const IS_CHROME = import.meta.env.CHROME === true;

// Transfer kind types per browser capability
// Chrome: All three (bitmap uses zero-copy MessageChannel)
// Firefox: Only blob and url (no MessageChannel support for transferables)
type ChromeTransferKind = 'bitmap' | 'blob' | 'url';
type FirefoxTransferKind = 'blob' | 'url';

// Exported type is the union - code should use VALID_TRANSFER_KINDS for runtime checks
export type ImageTransferKind = ChromeTransferKind | FirefoxTransferKind;

// Valid kinds per browser (for runtime validation)
const CHROME_KINDS: readonly ChromeTransferKind[] = ['bitmap', 'blob', 'url'];
const FIREFOX_KINDS: readonly FirefoxTransferKind[] = ['blob', 'url'];

export const VALID_TRANSFER_KINDS: readonly ImageTransferKind[] = IS_CHROME ? CHROME_KINDS : FIREFOX_KINDS;

/**
 * Whether MessageChannel transport is used (Chrome MV3 only).
 * Required for 'bitmap' transfer kind (zero-copy ImageBitmap).
 */
export const USE_MESSAGE_CHANNEL = IS_CHROME;

/**
 * Image transfer kind for inference payloads.
 * - 'bitmap': Zero-copy ImageBitmap via MessageChannel (Chrome only)
 * - 'blob': Blob via structured clone (~25MB overhead per image)
 * - 'url': URL string only, background fetches from cache (minimal overhead)
 */
export const IMAGE_TRANSFER_KIND: ImageTransferKind = IS_CHROME ? 'bitmap' : 'url';

// Validate at module load time - catches invalid config immediately
if (!VALID_TRANSFER_KINDS.includes(IMAGE_TRANSFER_KIND)) {
  throw new Error(
    `Invalid IMAGE_TRANSFER_KIND '${IMAGE_TRANSFER_KIND}' for ${IS_CHROME ? 'Chrome' : 'Firefox'}. ` +
      `Valid options: ${VALID_TRANSFER_KINDS.join(', ')}`,
  );
}
