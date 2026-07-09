import { computeRenderedContentRect, maskGridSrcRect } from '@/entrypoints/content/presentation/imageLayout';
import {
  classifyOverlayMutation,
  ensurePositionContext,
  overlayOffsetInParent,
} from '@/entrypoints/content/presentation/overlayPosition';
import { registerQuickToggle, unregisterQuickToggle } from '@/entrypoints/content/presentation/quickToggle';
import { logger } from '@/utils/logger';
import { calculatePixelationBlockSize, buildCanvasTintFilter } from '@/utils/masking';
import { decodeMaskRLE, type IRLEMask } from '@/utils/rle';
import {
  shouldBlock,
  type IHostSettings,
  type IImagePrediction,
  type IMaskTransform,
  type IElementPrediction,
  type IMaskingSettings,
} from '@/utils/types';

import type { IMediaOverlayState, IMediaOverlay } from '@/utils/types/presentation';

/**
 * Sites render decorative duplicates of an image obscured by their own blur
 * (Reddit dims + blurs a scaled background copy of the post image behind the
 * real one). When the site's blur is at least as strong as our own
 * pending-image blur, the copy is already protected to our standard — an
 * opaque pixelated mask on top of it is MORE visible than the original and
 * reads as a duplicated/broken mask. Hide ours while the site's blur holds;
 * re-evaluated on every geometry update.
 */
const SITE_OBSCURING_MIN_BLUR_PX = 15; // matches .haramblock-initial-blur

const isObscuredBySite = (image: HTMLImageElement): boolean => {
  const radius = /blur\((\d+(?:\.\d+)?)px\)/.exec(getComputedStyle(image).filter)?.[1];
  return radius !== undefined && parseFloat(radius) >= SITE_OBSCURING_MIN_BLUR_PX;
};

/**
 * Overlays owned by a live state. Several masked images can share one parent
 * (Reddit renders a decorative background copy next to the primary), so the
 * stale-overlay sweep must only remove orphans, never a sibling's live mask.
 */
const liveOverlays = new WeakSet<HTMLDivElement>();

/** Type guard to check if a prediction has valid RLE mask data */
function hasValidMask(prediction: IElementPrediction): prediction is IElementPrediction & { masks: IRLEMask } {
  return (
    prediction.masks !== undefined &&
    prediction.masks !== null &&
    Array.isArray(prediction.masks.runs) &&
    prediction.masks.runs.length > 0
  );
}

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

    registerQuickToggle(image, imagePrediction, hostSettings);

    if (!shouldBlock(imagePrediction)) {
      this.removeMaskOverlayOnly(image);
      return;
    }

    const parent = image.parentElement;
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

    // Collect all masks for single overlay
    const allMasks: { masks: number[][] }[] = [];
    for (const prediction of imagePrediction.predictions) {
      if (hasValidMask(prediction)) {
        allMasks.push({ masks: decodeMaskRLE(prediction.masks) });
      }
    }

    // Create single overlay for all masks
    if (allMasks.length > 0) {
      const state = this.createSingleImageMaskOverlay(
        image,
        allMasks,
        imagePrediction.maskTransform,
        imagePrediction.width,
        imagePrediction.height,
        hostSettings.masking,
      );

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
      const parent = image.parentElement;
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
      const parent = image.parentElement;
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
    allMasks: { masks: number[][] }[],
    maskTransform: IMaskTransform,
    originalWidth: number,
    originalHeight: number,
    masking: IMaskingSettings,
  ): IMediaOverlayState {
    const parent = image.parentElement;
    if (!parent) throw new Error('Image has no parent');

    // Force layout recalculation to get accurate dimensions
    void image.offsetHeight; // trigger reflow

    const imageRect = image.getBoundingClientRect();
    const contentRect = computeRenderedContentRect(image, imageRect);
    const parentRect = parent.getBoundingClientRect();
    const offset = overlayOffsetInParent(parent, imageRect, parentRect);

    // Create single overlay container for all masks
    const overlay = document.createElement('div');
    overlay.setAttribute('data-mask-overlay', 'unified-mask-overlay');

    // Get the image's z-index and add 1
    const imageZIndex = parseInt(getComputedStyle(image).zIndex) || 0;
    const overlayZIndex = imageZIndex + 1;

    overlay.style.cssText = `
    position: absolute;
    top: ${offset.top}px;
    left: ${offset.left}px;
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
      logger.withTag('maskOverlay').error('Failed to get canvas context');
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
      trackedSrc: image.currentSrc || image.src,
      masking,
    };

    // Initial render
    renderUnifiedCanvasMask(
      canvas,
      ctx,
      allMasks,
      maskTransform,
      originalWidth,
      originalHeight,
      imageRect.width, // overlay (element) width
      imageRect.height, // overlay (element) height
      image,
      contentRect.offsetX,
      contentRect.offsetY,
      contentRect.width,
      contentRect.height,
      masking,
    );

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

    const parent = image.parentElement;
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
      const currentSrc = image.currentSrc || image.src;
      if (state.trackedSrc && currentSrc !== state.trackedSrc) {
        this.clearMaskOverlay(image);
        return;
      }

      for (const entry of entries) {
        const newWidth = entry.contentRect.width;
        const newHeight = entry.contentRect.height;
        if (newWidth !== state.lastSize.width || newHeight !== state.lastSize.height) {
          state.lastSize = { width: newWidth, height: newHeight };
          scheduleUpdate();
        }
      }
    });
    state.resizeObserver.observe(image);

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
      // moved: keep the mask glued to the image's current parent
      const parent = image.parentElement;
      if (parent && state.overlay.parentElement !== parent) {
        ensurePositionContext(parent);
        parent.appendChild(state.overlay);
      }
      scheduleUpdate();
    });
    state.cleanupObserver.observe(document.body, { childList: true, subtree: true });
  }

  private updateOverlayForImage(image: HTMLImageElement, state: IMediaOverlayState): void {
    // Self-clean if src changed
    const currentSrc = image.currentSrc || image.src;
    if (state.trackedSrc && currentSrc !== state.trackedSrc) {
      this.clearMaskOverlay(image);
      return;
    }

    const imagePrediction = state.currentPrediction;
    if (!imagePrediction || !imagePrediction.predictions.length) {
      this.clearMaskOverlay(image);
      return;
    }
    const parent = image.parentElement;
    if (!parent || state.destroyed) return;

    // Force layout recalculation to get accurate dimensions
    void image.offsetHeight; // reflow

    ensurePositionContext(parent);

    const imageRect = image.getBoundingClientRect();
    const contentRect = computeRenderedContentRect(image, imageRect);
    const parentRect = parent.getBoundingClientRect();
    const offset = overlayOffsetInParent(parent, imageRect, parentRect);

    // Update overlay position and size
    state.overlay.style.display = isObscuredBySite(image) ? 'none' : '';
    state.overlay.style.top = `${offset.top}px`;
    state.overlay.style.left = `${offset.left}px`;
    state.overlay.style.width = `${imageRect.width}px`;
    state.overlay.style.height = `${imageRect.height}px`;

    // Collect masks
    const allMasks: { masks: number[][] }[] = [];
    for (const prediction of imagePrediction.predictions) {
      if (hasValidMask(prediction)) {
        allMasks.push({ masks: decodeMaskRLE(prediction.masks) });
      }
    }
    if (!allMasks.length) return;

    renderUnifiedCanvasMask(
      state.canvas,
      state.ctx,
      allMasks,
      imagePrediction.maskTransform,
      imagePrediction.width,
      imagePrediction.height,
      imageRect.width,
      imageRect.height,
      image,
      contentRect.offsetX,
      contentRect.offsetY,
      contentRect.width,
      contentRect.height,
      state.masking,
    );
  }
}

// Helper function for rendering unified canvas mask
const renderUnifiedCanvasMask = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  allMasks: { masks: number[][] }[],
  maskTransform: IMaskTransform,
  originalWidth: number,
  originalHeight: number,
  overlayWidth: number,
  overlayHeight: number,
  image: HTMLImageElement,
  offsetXInOverlay: number,
  offsetYInOverlay: number,
  contentWidth: number,
  contentHeight: number,
  masking: IMaskingSettings,
): void => {
  if (!allMasks || !allMasks.length) return;
  if (overlayWidth <= 0 || overlayHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    // Nothing visible to mask (e.g. the element collapsed to zero size when a
    // lightbox hid it). Drop the previous frame too: the overlay div does not
    // clip by itself, so a stale painted canvas would keep showing at the
    // canvas's old CSS size.
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.width = '0px';
    canvas.style.height = '0px';
    return;
  }

  const dWidth = contentWidth;
  const dHeight = contentHeight;

  // Ensure canvas bitmap matches display size for crisp pixels
  canvas.width = overlayWidth;
  canvas.height = overlayHeight;
  canvas.style.width = `${overlayWidth}px`;
  canvas.style.height = `${overlayHeight}px`;

  const blockSize = calculatePixelationBlockSize(masking.pixelationScale);
  const smallW = Math.max(1, Math.floor(dWidth / blockSize));
  const smallH = Math.max(1, Math.floor(dHeight / blockSize));

  const tmp = document.createElement('canvas');
  tmp.width = smallW;
  tmp.height = smallH;
  const tctx = tmp.getContext('2d');
  if (!tctx) {
    logger.withTag('maskOverlay').error('Failed to get tmp canvas context');
    return;
  }

  // Downscale to small with smoothing, then upscale without smoothing to get blocky squares
  tctx.imageSmoothingEnabled = true; // smoother downscale average
  tctx.clearRect(0, 0, smallW, smallH);

  // Draw the entire source image. Never pass naturalWidth/naturalHeight as a source
  // rect: for srcset images with w descriptors they are density-corrected CSS
  // dimensions, not resource pixels, so the rect overshoots the bitmap and the
  // clipped draw leaves the bottom/right of the content unpixelated (and therefore
  // unmasked after the destination-in composite).
  tctx.drawImage(image, 0, 0, smallW, smallH);

  ctx.imageSmoothingEnabled = false; // crisp, blocky upscale
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw pixelated image only in the actual rendered content box inside the <img>
  ctx.drawImage(tmp, offsetXInOverlay, offsetYInOverlay, dWidth, dHeight);

  // 2) Build alpha mask via grid-space canvas, then scale/crop to image content
  const first = allMasks.find(m => m.masks && m.masks.length);
  const gridH = first?.masks.length || 0;
  const gridW = first?.masks[0]?.length || 0;
  if (!gridW || !gridH) return;

  const maskGrid = document.createElement('canvas');
  maskGrid.width = gridW;
  maskGrid.height = gridH;
  const mg = maskGrid.getContext('2d');
  if (!mg) {
    logger.withTag('maskOverlay').error('Failed to get grid mask context');
    return;
  }
  mg.clearRect(0, 0, gridW, gridH);
  mg.fillStyle = 'rgba(0,0,0,1)';

  const maskThreshold = 0.5;

  // Merge masks into grid by OR-ing cells that pass threshold
  for (const { masks } of allMasks) {
    const mh = masks.length;
    const mw = masks[0]?.length || 0;
    if (mw !== gridW || mh !== gridH) continue;

    for (let y = 0; y < mh; y++) {
      const row = masks[y];
      if (!row) continue;
      for (let x = 0; x < mw; x++) {
        const v = row[x];
        if (typeof v !== 'number' || v <= maskThreshold) continue;

        // Mask value is above threshold, fill this pixel
        mg.fillRect(x, y, 1, 1);
      }
    }
  }

  // Prepare mask onto overlay-sized canvas then composite
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = overlayWidth;
  maskCanvas.height = overlayHeight;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) {
    logger.withTag('maskOverlay').error('Failed to get mask canvas context');
    return;
  }
  maskCtx.clearRect(0, 0, overlayWidth, overlayHeight);

  // Source sub-rect in grid that corresponds to actual image content (excludes letterbox)
  const { srcX, srcY, srcW, srcH } = maskGridSrcRect(maskTransform, originalWidth, originalHeight);

  // Draw scaled mask aligned to image content rect inside the overlay
  maskCtx.imageSmoothingEnabled = false;
  maskCtx.drawImage(maskGrid, srcX, srcY, srcW, srcH, offsetXInOverlay, offsetYInOverlay, dWidth, dHeight);

  // 3) Keep only the masked parts of the pixelated image
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  // 4) Apply tint effects via CSS filter (hardware-accelerated)
  canvas.style.filter = buildCanvasTintFilter(masking);
};

// Helper function for removing legacy overlays
const removeExistingImageOverlays = (parent: HTMLElement): void => {
  const existingOverlays = parent.querySelectorAll('[data-mask-overlay]');
  existingOverlays.forEach(overlay => {
    if (!liveOverlays.has(overlay as HTMLDivElement)) overlay.remove();
  });
};

// Export singleton instance
export const imageMaskOverlay = new ImageMaskOverlay();
