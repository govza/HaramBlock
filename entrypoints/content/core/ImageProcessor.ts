import { requestImageInference, requestToggleUpdate } from '@/entrypoints/content/communication/sender';
import { clearBlurBoxOverlay, hasBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { BLACKLIST_ATTR, BLUR_CLASS } from '@/entrypoints/content/presentation/constants';
import { imageMaskOverlay } from '@/entrypoints/content/presentation/imageMaskOverlay';
import {
  applyBlacklistStyling,
  applyInitialImageStyling,
  finalizeImageProcessing,
  hasBlacklistStyling,
  hasInitialStyling,
  resetImageStyling,
} from '@/entrypoints/content/presentation/initialStyling';
import { applyPredictionsStyling } from '@/entrypoints/content/presentation/predictionStyling';
import {
  destroyQuickToggle,
  initQuickToggle,
  registerQuickToggle,
  unregisterQuickToggle,
} from '@/entrypoints/content/presentation/quickToggle';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

// =============================================================================
// Constants
// =============================================================================

const SVG_PATTERN = /\.svg(?:[?#]|$)|image\/svg\+xml/i;
const MAX_CACHE_SIZE = 500;
const SRC_STABILIZATION_DELAY = 150;

const PRIORITY_VISIBLE = 10;
const PRIORITY_OFFSCREEN = 0;

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
  private readonly srcChangeDebounce = new WeakMap<HTMLImageElement, ReturnType<typeof setTimeout>>();
  private readonly visibilityMap = new WeakMap<HTMLImageElement, boolean>();
  private readonly visibilityObserver: IntersectionObserver;

  constructor(private readonly hostSettings: IHostSettings) {
    initQuickToggle((src, forcedVisibility) => this.handleToggle(src, forcedVisibility));

    this.visibilityObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          this.visibilityMap.set(entry.target as HTMLImageElement, entry.isIntersecting);
        }
      },
      { rootMargin: '200px' },
    );
  }

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

    this.visibilityObserver.observe(img);

    // Skip non-processable formats
    if (SVG_PATTERN.test(src)) {
      finalizeImageProcessing(img, 'skipped');
      return;
    }

    // Blacklist policy: apply blacklist styling if not already applied
    if (this.hostSettings.policy === 'blacklist') {
      if (hasBlacklistStyling(img)) {
        return; // Already blacklisted
      }
      // Clear any overlays from previous state and apply blacklist styling
      this.clearOverlays(img);
      applyBlacklistStyling(img, this.hostSettings);
      return;
    }

    // Skip if already has overlay for current src
    if (this.hasOverlayForSrc(img, src)) {
      return;
    }

    // Check cache first - apply immediately if available
    const cached = this.cache.get(src);
    if (cached) {
      this.applyPrediction(img, cached);
      return;
    }

    // Apply blur if not already present (idempotent)
    if (!hasInitialStyling(img)) {
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
   * Handle src attribute change - debounce to let src stabilize before reprocessing.
   * Google Images rapidly changes src (quality upgrades), so we wait for it to settle.
   */
  handleSrcChange(img: HTMLImageElement): void {
    // Clear any existing overlays (they may be for old src)
    this.clearOverlays(img);

    // Ensure blur is applied while waiting for stabilization
    if (!hasInitialStyling(img)) {
      applyInitialImageStyling(img, this.hostSettings);
    }

    // Cancel any pending debounce for this image
    const existingTimeout = this.srcChangeDebounce.get(img);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Debounce: wait for src to stabilize before processing
    const timeout = setTimeout(() => {
      this.srcChangeDebounce.delete(img);
      const src = img.currentSrc || img.src;
      if (src) {
        this.process(img);
      }
    }, SRC_STABILIZATION_DELAY);

    this.srcChangeDebounce.set(img, timeout);
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
    const timeout = this.srcChangeDebounce.get(img);
    if (timeout) {
      clearTimeout(timeout);
      this.srcChangeDebounce.delete(img);
    }
    this.visibilityObserver.unobserve(img);
    clearBlurBoxOverlay(img);
    unregisterQuickToggle(img);
  }

  /**
   * Clean up resources when processor is disposed.
   */
  dispose(): void {
    this.visibilityObserver.disconnect();
    destroyQuickToggle();
  }

  private handleToggle(src: string, forcedVisibility: IImagePrediction['forcedVisibility']): void {
    const cached = this.cache.get(src);
    if (!cached) return;

    const updated = { ...cached, forcedVisibility };
    this.cache.set(src, updated);
    void requestToggleUpdate(src, forcedVisibility);

    const images = this.findAllImagesBySrc(src);
    for (const img of images) {
      this.clearOverlays(img);
      if (forcedVisibility === 'blocked') {
        applyBlacklistStyling(img, this.hostSettings);
      } else if (forcedVisibility === null && updated.predictions.length > 0) {
        void applyPredictionsStyling([img], [updated], this.hostSettings);
      }
      // Always register quick toggle for all states
      registerQuickToggle(img, updated, this.hostSettings.quickToggle);
    }
  }

  // ===========================================================================
  // State Queries (DOM-derived)
  // ===========================================================================

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
        finalizeImageProcessing(img, 'skipped');
        return;
      }

      try {
        const isVisible = this.visibilityMap.get(img) ?? false;
        const priority = isVisible ? PRIORITY_VISIBLE : PRIORITY_OFFSCREEN;
        await requestImageInference(this.hostSettings.hostname, img, priority);
      } catch {
        this.pendingInference.delete(src);
        finalizeImageProcessing(img, 'skipped');
      }
    };

    const handleError = () => {
      this.pendingInference.delete(src);
      finalizeImageProcessing(img, 'skipped');
    };

    if (img.complete && img.naturalWidth > 0) {
      // Image already loaded with dimensions - send immediately
      void sendRequest();
    } else {
      // Use both decode() and load event - whichever fires first wins
      // This handles edge cases where one mechanism fails
      let handled = false;
      const onReady = () => {
        if (handled) return;
        handled = true;
        void sendRequest();
      };
      const onFail = () => {
        if (handled) return;
        handled = true;
        handleError();
      };

      img.decode().then(onReady).catch(onFail);
      img.addEventListener('load', onReady, { once: true });
      img.addEventListener('error', onFail, { once: true });
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

      // Finalize processing with status based on AI result (not forced visibility)
      const hasDetections = prediction.predictions.length > 0;
      finalizeImageProcessing(img, hasDetections ? 'unsafe' : 'safe');

      if (prediction.forcedVisibility === 'blocked') {
        applyBlacklistStyling(img, this.hostSettings);
        registerQuickToggle(img, prediction, this.hostSettings.quickToggle);
      } else if (prediction.forcedVisibility === 'visible') {
        registerQuickToggle(img, prediction, this.hostSettings.quickToggle);
      } else if (hasDetections) {
        await applyPredictionsStyling([img], [prediction], this.hostSettings);
      } else {
        registerQuickToggle(img, prediction, this.hostSettings.quickToggle);
      }
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
    unregisterQuickToggle(img);
    resetImageStyling(img);
  }

  private findImagesBySrc(src: string): HTMLImageElement[] {
    const results: HTMLImageElement[] = [];
    const pendingImages = document.querySelectorAll<HTMLImageElement>(`img.${BLUR_CLASS}, img[${BLACKLIST_ATTR}]`);

    for (const img of pendingImages) {
      const imgSrc = img.currentSrc || img.src;
      if (imgSrc === src) {
        results.push(img);
      }
    }

    return results;
  }

  // Queries all images on each call. Acceptable for user-initiated toggles (infrequent).
  // Maintaining a src→elements index would require complex cleanup for removed elements.
  private findAllImagesBySrc(src: string): HTMLImageElement[] {
    const results: HTMLImageElement[] = [];
    const allImages = document.querySelectorAll<HTMLImageElement>('img');

    for (const img of allImages) {
      const imgSrc = img.currentSrc || img.src;
      if (imgSrc === src) {
        results.push(img);
      }
    }

    return results;
  }
}
