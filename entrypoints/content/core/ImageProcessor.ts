import { requestImageInference } from '@/entrypoints/content/communication/sender';
import { clearBlurBoxOverlay, hasBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { imageMaskOverlay } from '@/entrypoints/content/presentation/imageMaskOverlay';
import { applyInitialImageStyling, removeInitialImageStyling } from '@/entrypoints/content/presentation/initialStyling';
import { applyPredictionsStyling } from '@/entrypoints/content/presentation/predictionStyling';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

// =============================================================================
// Constants
// =============================================================================

const BLUR_CLASS = 'haramblock-initial-blur';
const BLACKLIST_CLASS = 'haramblock-blacklist';
const SVG_PATTERN = /\.svg(?:[?#]|$)|image\/svg\+xml/i;
const MAX_CACHE_SIZE = 500;

// =============================================================================
// ImageProcessor
// =============================================================================

/**
 * Processes images with minimal blocking and DOM-derived state.
 *
 * State is derived from DOM, not tracked separately:
 * - No blur class, no overlay → Unprocessed
 * - Has blur class, no overlay → Pending inference
 * - Has overlay → Complete
 *
 * Key design:
 * - Idempotent operations (safe to call multiple times)
 * - Fire and forget async work
 * - Predictions matched by src (stale ones find no matches)
 * - Self-cleaning overlays (via src tracking in overlay modules)
 */
export class ImageProcessor {
  private readonly cache = new Map<string, IImagePrediction>();
  private readonly pendingInference = new Set<string>();

  constructor(private readonly hostSettings: IHostSettings) {}

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Process an image. Idempotent - safe to call multiple times.
   * This is the main entry point for both new images and attribute changes.
   */
  process(img: HTMLImageElement): void {
    const src = img.currentSrc || img.src;
    if (!src) return;

    // Skip if already has overlay for current src
    if (this.hasOverlayForSrc(img, src)) {
      return;
    }

    // Skip non-processable formats
    if (SVG_PATTERN.test(src)) {
      return;
    }

    // Check cache first - apply immediately if available
    const cached = this.cache.get(src);
    if (cached) {
      this.applyPrediction(img, cached);
      return;
    }

    // Apply blur if not already present (idempotent)
    if (!this.hasBlurClass(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    // Queue for inference (deduped by src)
    this.queueInference(img, src);
  }

  /**
   * Process multiple images.
   */
  processAll(images: HTMLImageElement[]): void {
    for (const img of images) {
      this.process(img);
    }
  }

  /**
   * Handle src attribute change - clear old overlay, reprocess.
   */
  handleSrcChange(img: HTMLImageElement): void {
    // Clear any existing overlays (they may be for old src)
    this.clearOverlays(img);
    removeInitialImageStyling(img);

    // Reprocess with new src
    this.process(img);
  }

  /**
   * Seed cache with predictions (e.g., from background on init).
   */
  seedCache(predictions: IImagePrediction[]): void {
    for (const pred of predictions) {
      this.addToCache(pred.src, pred);
    }
  }

  /**
   * Handle predictions from background. Caches and applies to matching images.
   */
  handlePredictions(predictions: IImagePrediction[]): void {
    for (const pred of predictions) {
      this.addToCache(pred.src, pred);
      this.pendingInference.delete(pred.src);

      // Find and update all matching images
      const images = this.findImagesBySrc(pred.src);
      for (const img of images) {
        this.applyPrediction(img, pred);
      }
    }
  }

  /**
   * Clean up when image removed from DOM.
   */
  handleRemoved(img: HTMLImageElement): void {
    // Mask overlays self-clean via MutationObserver, but blur boxes don't
    clearBlurBoxOverlay(img);
  }

  // ===========================================================================
  // State Queries (DOM-derived)
  // ===========================================================================

  private hasBlurClass(img: HTMLImageElement): boolean {
    return img.classList.contains(BLUR_CLASS) || img.classList.contains(BLACKLIST_CLASS);
  }

  private hasOverlayForSrc(img: HTMLImageElement, _src: string): boolean {
    // Check if any overlay exists - they self-clean if src doesn't match
    return Boolean(imageMaskOverlay.hasMaskOverlay(img) || hasBlurBoxOverlay(img));
  }

  // ===========================================================================
  // Inference Queue
  // ===========================================================================

  private queueInference(img: HTMLImageElement, src: string): void {
    // Dedupe by src - only one request per unique src
    if (this.pendingInference.has(src)) {
      return;
    }

    // Mark pending immediately to prevent duplicate load handlers
    this.pendingInference.add(src);

    const sendRequest = async () => {
      // Abort if src changed before load
      const currentSrc = img.currentSrc || img.src;
      if (currentSrc !== src) {
        this.pendingInference.delete(src);
        return;
      }

      // Check size
      if (this.isBelowMinSize(img)) {
        this.pendingInference.delete(src);
        removeInitialImageStyling(img);
        return;
      }

      try {
        await requestImageInference(this.hostSettings.hostname, img);
      } catch {
        this.pendingInference.delete(src);
        removeInitialImageStyling(img);
      }
    };

    const handleError = () => {
      this.pendingInference.delete(src);
      removeInitialImageStyling(img);
    };

    if (img.complete && img.naturalWidth > 0) {
      // Image already loaded with dimensions - send immediately
      void sendRequest();
    } else if (img.complete) {
      // Image complete but no dimensions - either error or not decoded yet
      // Use decode() to wait for decoding or detect error
      img
        .decode()
        .then(() => void sendRequest())
        .catch(handleError);
    } else {
      // Image not complete - wait for load or error
      img.addEventListener('load', () => void sendRequest(), { once: true });
      img.addEventListener('error', handleError, { once: true });
    }
  }

  private isBelowMinSize(img: HTMLImageElement): boolean {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    return w < this.hostSettings.minSize.width || h < this.hostSettings.minSize.height;
  }

  // ===========================================================================
  // Prediction Application
  // ===========================================================================

  private applyPrediction(img: HTMLImageElement, prediction: IImagePrediction): void {
    const currentSrc = img.currentSrc || img.src;

    // Verify src still matches (handles race where src changed)
    if (currentSrc !== prediction.src) {
      return;
    }

    const apply = async () => {
      // Double-check src after any async wait
      const srcNow = img.currentSrc || img.src;
      if (srcNow !== prediction.src) {
        return;
      }

      // Clear any existing overlays first
      this.clearOverlays(img);

      // Apply styling if there are detections
      if (prediction.predictions && prediction.predictions.length > 0) {
        await applyPredictionsStyling([img], [prediction], this.hostSettings);
      }

      // Remove blur - prediction is now applied (or no detections)
      removeInitialImageStyling(img);
    };

    // Wait for load if needed
    if (img.complete && img.naturalWidth > 0) {
      void apply();
    } else {
      img.addEventListener('load', () => void apply(), { once: true });
    }
  }

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  private addToCache(src: string, prediction: IImagePrediction): void {
    this.cache.set(src, prediction);

    // Evict oldest entries if over limit
    if (this.cache.size > MAX_CACHE_SIZE) {
      const keysToDelete = this.cache.size - MAX_CACHE_SIZE;
      const iterator = this.cache.keys();
      for (let i = 0; i < keysToDelete; i++) {
        const key = iterator.next().value;
        if (key) this.cache.delete(key);
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private clearOverlays(img: HTMLImageElement): void {
    imageMaskOverlay.clearMaskOverlay(img);
    clearBlurBoxOverlay(img);
  }

  private findImagesBySrc(src: string): HTMLImageElement[] {
    // Query pending images (those with blur class waiting for predictions)
    // and compare resolved src (not attribute value) to handle relative URLs
    const results: HTMLImageElement[] = [];
    const pendingImages = document.querySelectorAll<HTMLImageElement>(`img.${BLUR_CLASS}, img.${BLACKLIST_CLASS}`);

    for (const img of pendingImages) {
      const imgSrc = img.currentSrc || img.src;
      if (imgSrc === src) {
        results.push(img);
      }
    }

    return results;
  }
}
