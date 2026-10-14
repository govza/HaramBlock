import { resolveImageSource } from '@/entrypoints/content/core/imageSource';
import { IMAGE_MASK_OVERLAY_ATTR } from '@/entrypoints/content/presentation/constants';
import { computeRenderedContentRect, type ContentRect } from '@/entrypoints/content/presentation/imageLayout';
import { hasInitialStyling } from '@/entrypoints/content/presentation/initialStyling';
import { MaskCoverage, paintPixelatedMask } from '@/entrypoints/content/presentation/maskCoverage';
import {
  classifyOverlayMutation,
  ensurePositionContext,
  overlayPlacement,
  resolveAnchorParent,
} from '@/entrypoints/content/presentation/overlayPosition';
import {
  predictionToggleRegistration,
  registerQuickToggle,
  unregisterQuickToggle,
} from '@/entrypoints/content/presentation/quickToggle';
import { notifySrcDrift } from '@/entrypoints/content/presentation/srcDrift';
import { getLogger } from '@/utils/telemetry';
import { shouldBlock, type IHostSettings, type IImagePrediction, type IMaskingSettings } from '@/utils/types';

import type { IMediaOverlayState, IMediaOverlay } from '@/utils/types/presentation';

const log = getLogger('imageMaskOverlay');

/**
 * An image the site already blurs at least as strongly as our own pending
 * blur (decorative background copies) is protected to our standard; an opaque
 * pixelated mask on top would be more visible than the original. Hide ours
 * while the site's blur holds; re-evaluated on every geometry update.
 */
const SITE_OBSCURING_MIN_BLUR_PX = 15; // matches .haramblock-initial-blur

const isObscuredBySite = (image: HTMLImageElement): boolean => {
  // Our own protective styling contributes the same computed filter and must
  // not count as site obscuration — it is stripped once the overlay is up
  if (hasInitialStyling(image)) return false;
  const radius = /blur\((\d+(?:\.\d+)?)px\)/.exec(getComputedStyle(image).filter)?.[1];
  return radius !== undefined && parseFloat(radius) >= SITE_OBSCURING_MIN_BLUR_PX;
};

/**
 * Overlays owned by a live state. Several masked images can share one parent
 * (Reddit renders a decorative background copy next to the primary), so the
 * stale-overlay sweep must only remove orphans, never a sibling's live mask.
 */
const liveOverlays = new WeakSet<HTMLDivElement>();

/**
 * Manages mask overlays for image elements.
 * Implements IMediaOverlayModuleAPI<HTMLImageElement>
 */
class ImageMaskOverlay implements IMediaOverlay {
  private imageStates = new WeakMap<HTMLImageElement, IMediaOverlayState>();

  createMaskOverlay(
    image: HTMLImageElement,
    imagePrediction: IImagePrediction,
    hostSettings: IHostSettings,
    skipObserverSetup = false,
  ): void {
    if (!imagePrediction.predictions.length || !image.complete || image.naturalWidth === 0) {
      this.clearMaskOverlay(image);
      return;
    }

    registerQuickToggle(image, predictionToggleRegistration(imagePrediction, hostSettings));

    if (!shouldBlock(imagePrediction)) {
      this.removeMaskOverlayOnly(image);
      return;
    }

    const parent = resolveAnchorParent(image);
    if (!parent) return;

    ensurePositionContext(parent);

    // If we already manage an overlay for this image, just update/redraw
    const existingState = this.imageStates.get(image);
    if (existingState && !existingState.destroyed) {
      // Update stored prediction and re-render; re-attach if the site's
      // re-render dropped the overlay without our observer catching it
      existingState.currentPrediction = imagePrediction;
      if (!existingState.overlay.isConnected) {
        parent.appendChild(existingState.overlay);
      }
      this.updateOverlayForImage(image, existingState);
      return;
    }

    // Remove legacy overlays created by older runs (one-time cleanup)
    removeExistingImageOverlays(parent);

    const coverage = coverageOf(imagePrediction);
    if (coverage) {
      const state = this.createSingleImageMaskOverlay(image, coverage, hostSettings.masking);

      // Set up observers for this image (only on initial setup)
      if (!skipObserverSetup) {
        state.currentPrediction = imagePrediction;
        this.setupObservers(image, state);
      }
    }
  }

  /**
   * Removes the visual mask overlay without affecting eye toggle registration.
   * Used when user toggles masking off.
   */
  private removeMaskOverlayOnly(image: HTMLImageElement): void {
    const state = this.imageStates.get(image);
    if (state) {
      // Full disposal (not just detaching the overlay): a kept-alive state
      // would have the cleanup observer re-homing the overlay right back on
      // the next site mutation. Re-masking goes through the create path.
      this.disposeState(image, state);
    } else {
      const parent = resolveAnchorParent(image);
      if (parent) removeExistingImageOverlays(parent);
    }
  }

  /** Tears down a state: observers, handlers, overlay element, registry. */
  private disposeState(image: HTMLImageElement, state: IMediaOverlayState): void {
    try {
      state.resizeObserver.disconnect();
    } catch {
      // no-op
    }
    try {
      state.cleanupObserver.disconnect();
    } catch {
      // no-op
    }
    if (state.viewportHandler) {
      globalThis.removeEventListener('resize', state.viewportHandler);
      state.viewportHandler = undefined;
    }
    state.destroyed = true;
    liveOverlays.delete(state.overlay);
    if (state.overlay.parentElement) state.overlay.remove();
    this.imageStates.delete(image);
  }

  /**
   * Clears mask overlay for image elements.
   */
  clearMaskOverlay(image: HTMLImageElement): void {
    const state = this.imageStates.get(image);
    if (state) {
      this.disposeState(image, state);
    } else {
      // Fallback: remove any stale (orphaned) overlay elements
      const parent = resolveAnchorParent(image);
      if (parent) removeExistingImageOverlays(parent);
    }
    // Unregister from eye toggle
    unregisterQuickToggle(image);
  }

  /**
   * Checks if image has an active mask overlay. A state whose overlay left
   * the DOM (site re-render our observer missed) does not count — reporting
   * it as active would block the processing pass that could recreate it.
   */
  hasMaskOverlay(image: HTMLImageElement): boolean {
    const state = this.imageStates.get(image);
    return state !== undefined && !state.destroyed && state.overlay.isConnected;
  }

  private createSingleImageMaskOverlay(
    image: HTMLImageElement,
    coverage: MaskCoverage,
    masking: IMaskingSettings,
  ): IMediaOverlayState {
    const parent = resolveAnchorParent(image);
    if (!parent) throw new Error('Image has no parent');

    // Force layout recalculation to get accurate dimensions
    void image.offsetHeight; // trigger reflow

    const imageRect = image.getBoundingClientRect();
    const contentRect = computeRenderedContentRect(image, imageRect);
    const parentRect = parent.getBoundingClientRect();
    const placement = overlayPlacement(image, parent, imageRect, parentRect);

    // Create single overlay container for all masks
    const overlay = document.createElement('div');
    overlay.setAttribute(IMAGE_MASK_OVERLAY_ATTR, 'unified-mask-overlay');

    // Get the image's z-index and add 1
    const imageZIndex = parseInt(getComputedStyle(image).zIndex) || 0;
    const overlayZIndex = imageZIndex + 1;

    overlay.style.cssText = `
    position: ${placement.position};
    top: ${placement.top}px;
    left: ${placement.left}px;
    width: ${imageRect.width}px;
    height: ${imageRect.height}px;
    overflow: hidden;
    pointer-events: none;
    z-index: ${overlayZIndex};
  `;

    // Create canvas once and reuse on updates
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: ${imageRect.width}px;
    height: ${imageRect.height}px;
    pointer-events: none;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  `;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      log.error('overlay.canvas_context.failed', { canvas: 'main' });
      throw new Error('Failed to get canvas context');
    }

    if (isObscuredBySite(image)) {
      overlay.style.display = 'none';
    }

    overlay.appendChild(canvas);
    liveOverlays.add(overlay);
    parent.appendChild(overlay);

    const state: IMediaOverlayState = {
      overlay,
      canvas,
      ctx,
      // placeholders, real observers are attached in setupObservers
      resizeObserver: new ResizeObserver(() => {}),
      cleanupObserver: new MutationObserver(() => {}),
      lastSize: { width: imageRect.width, height: imageRect.height },
      rafId: null,
      destroyed: false,
      currentPrediction: undefined,
      trackedSrc: resolveImageSource(image),
      masking,
    };

    // Initial render
    renderUnifiedCanvasMask(ctx, image, coverage, imageRect, contentRect, masking);

    // Store state for subsequent updates
    this.imageStates.set(image, state);
    return state;
  }

  private setupObservers(image: HTMLImageElement, state: IMediaOverlayState): void {
    // Disconnect previous observers if any (for safety on re-init)
    try {
      state.resizeObserver.disconnect();
    } catch {
      // Observer may not exist or already disconnected
    }
    try {
      state.cleanupObserver.disconnect();
    } catch {
      // Observer may not exist or already disconnected
    }
    if (state.viewportHandler) {
      globalThis.removeEventListener('resize', state.viewportHandler);
      state.viewportHandler = undefined;
    }

    const parent = resolveAnchorParent(image);
    if (!parent) return;

    const scheduleUpdate = () => {
      if (state.destroyed) return;
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.rafId = requestAnimationFrame(() => {
        this.updateOverlayForImage(image, state);
        state.rafId = null;
      });
    };

    state.lastSize = { width: image.offsetWidth, height: image.offsetHeight };

    // ResizeObserver for image size changes + src change detection (self-cleaning)
    state.resizeObserver = new ResizeObserver(entries => {
      // Self-clean if src changed
      const currentSrc = resolveImageSource(image);
      if (state.trackedSrc && currentSrc !== state.trackedSrc) {
        this.clearMaskOverlay(image);
        notifySrcDrift(image);
        return;
      }

      for (const entry of entries) {
        if (entry.target !== image) {
          // The parent resized: the image's offsets within it change even when
          // the image size does not (flex re-centering, a custom element like
          // Reddit's <zoomable-img> upgrading from unstyled inline layout).
          scheduleUpdate();
          continue;
        }
        const newWidth = entry.contentRect.width;
        const newHeight = entry.contentRect.height;
        if (newWidth !== state.lastSize.width || newHeight !== state.lastSize.height) {
          state.lastSize = { width: newWidth, height: newHeight };
          scheduleUpdate();
        }
      }
    });
    state.resizeObserver.observe(image);
    state.resizeObserver.observe(parent);

    // Viewport changes that can affect layout
    state.viewportHandler = () => scheduleUpdate();
    globalThis.addEventListener('resize', state.viewportHandler);

    // Clean up when image is removed; re-home when a framework re-render
    // merely moved it (or dropped the overlay while keeping the image)
    state.cleanupObserver = new MutationObserver(mutations => {
      if (state.destroyed) return;
      const change = classifyOverlayMutation(mutations, image, state.overlay);
      if (change === 'none') return;
      if (change === 'detached') {
        this.disposeState(image, state);
        return;
      }
      // moved: keep the mask glued to the image's current anchor parent
      const parent = resolveAnchorParent(image);
      if (parent && state.overlay.parentElement !== parent) {
        ensurePositionContext(parent);
        parent.appendChild(state.overlay);
        state.resizeObserver.observe(parent);
      }
      scheduleUpdate();
    });
    state.cleanupObserver.observe(document.body, { childList: true, subtree: true });
  }

  private updateOverlayForImage(image: HTMLImageElement, state: IMediaOverlayState): void {
    // Self-clean if src changed
    const currentSrc = resolveImageSource(image);
    if (state.trackedSrc && currentSrc !== state.trackedSrc) {
      this.clearMaskOverlay(image);
      notifySrcDrift(image);
      return;
    }

    const imagePrediction = state.currentPrediction;
    if (!imagePrediction || !imagePrediction.predictions.length) {
      this.clearMaskOverlay(image);
      return;
    }
    const parent = resolveAnchorParent(image);
    if (!parent || state.destroyed) return;

    // Force layout recalculation to get accurate dimensions
    void image.offsetHeight; // reflow

    ensurePositionContext(parent);

    const imageRect = image.getBoundingClientRect();
    const contentRect = computeRenderedContentRect(image, imageRect);
    const parentRect = parent.getBoundingClientRect();
    const placement = overlayPlacement(image, parent, imageRect, parentRect);

    // Update overlay position and size
    state.overlay.style.display = isObscuredBySite(image) ? 'none' : '';
    state.overlay.style.position = placement.position;
    state.overlay.style.top = `${placement.top}px`;
    state.overlay.style.left = `${placement.left}px`;
    state.overlay.style.width = `${imageRect.width}px`;
    state.overlay.style.height = `${imageRect.height}px`;

    const coverage = coverageOf(imagePrediction);
    if (!coverage) return;

    renderUnifiedCanvasMask(state.ctx, image, coverage, imageRect, contentRect, state.masking);
  }
}

const coverageOf = (imagePrediction: IImagePrediction): MaskCoverage | null =>
  MaskCoverage.from(
    imagePrediction.predictions,
    imagePrediction.maskTransform,
    imagePrediction.width,
    imagePrediction.height,
  );

/**
 * Sizes the overlay canvas to the element box before painting. A collapsed element (e.g. hidden by a
 * lightbox) drops the previous frame too: the overlay div does not clip by itself, so a stale painted
 * canvas would keep showing at its old CSS size.
 */
const renderUnifiedCanvasMask = (
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  coverage: MaskCoverage,
  overlaySize: { width: number; height: number },
  contentRect: ContentRect,
  masking: IMaskingSettings,
): void => {
  const { canvas } = ctx;
  const { width, height } = overlaySize;
  if (width <= 0 || height <= 0 || contentRect.width <= 0 || contentRect.height <= 0) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.width = '0px';
    canvas.style.height = '0px';
    return;
  }

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  paintPixelatedMask(ctx, image, coverage, contentRect, masking);
};

// Helper function for removing legacy overlays
const removeExistingImageOverlays = (parent: HTMLElement): void => {
  const existingOverlays = parent.querySelectorAll(`[${IMAGE_MASK_OVERLAY_ATTR}]`);
  existingOverlays.forEach(overlay => {
    if (!liveOverlays.has(overlay as HTMLDivElement)) overlay.remove();
  });
};

// Export singleton instance
export const imageMaskOverlay = new ImageMaskOverlay();
