import {
  computeRenderedContentRect,
  maskGridSrcRect,
  type ContentRect,
} from '@/entrypoints/content/presentation/imageLayout';
import { overlayLayer } from '@/entrypoints/content/presentation/layer/overlayLayer';
import { registerQuickToggle, unregisterQuickToggle } from '@/entrypoints/content/presentation/quickToggle';
import { isConsoleLoggingEnabled, logger } from '@/utils/logger';
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

import type { ILayerGeometry, IMediaOverlayState, IMediaOverlay } from '@/utils/types/presentation';

/** Type guard to check if a prediction has valid RLE mask data */
function hasValidMask(prediction: IElementPrediction): prediction is IElementPrediction & { masks: IRLEMask } {
  return (
    prediction.masks !== undefined &&
    prediction.masks !== null &&
    Array.isArray(prediction.masks.runs) &&
    prediction.masks.runs.length > 0
  );
}

/** Decode all RLE masks of a prediction once; geometry updates reuse the grids. */
function decodePredictionMasks(prediction: IImagePrediction): { masks: number[][] }[] {
  const allMasks: { masks: number[][] }[] = [];
  for (const elementPrediction of prediction.predictions) {
    if (hasValidMask(elementPrediction)) {
      allMasks.push({ masks: decodeMaskRLE(elementPrediction.masks) });
    }
  }
  return allMasks;
}

// Last render snapshot per element — a redraw fires every frame during carousel scale
// animations, so the snapshot is only logged when its inputs actually change.
const lastRenderSnapshot = new WeakMap<HTMLImageElement, string>();

/** One-line JSON render snapshot (single string so MCP console capture can read it). */
const logRenderSnapshot = (image: HTMLImageElement, state: IMediaOverlayState, contentRect: ContentRect): void => {
  if (!isConsoleLoggingEnabled()) return;
  const prediction = state.currentPrediction;
  if (!prediction) return;

  const firstMask = state.decodedMasks?.find(m => m.masks.length);
  const snapshot = JSON.stringify({
    src: (image.currentSrc || image.src).slice(-60),
    predWidth: prediction.width,
    predHeight: prediction.height,
    maskTransform: prediction.maskTransform,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    srcMatches: (image.currentSrc || image.src) === prediction.src,
    lastSize: state.lastSize,
    contentRect,
    gridW: firstMask?.masks[0]?.length ?? 0,
    gridH: firstMask?.masks.length ?? 0,
    objectFit: getComputedStyle(image).objectFit,
  });

  if (lastRenderSnapshot.get(image) === snapshot) return;
  lastRenderSnapshot.set(image, snapshot);
  logger.withTag('maskOverlay').debug(`render ${snapshot}`);
};

const CANVAS_STYLE = [
  'position: absolute',
  'top: 0',
  'left: 0',
  'pointer-events: none',
  'image-rendering: pixelated',
  'image-rendering: crisp-edges',
].join('; ');

/**
 * Manages mask overlays for image elements, rendered into the extension-owned overlay
 * layer (never into site DOM). The layer positions each slot in viewport coordinates;
 * this module only redraws when the element's size (not position) changes.
 * Implements IMediaOverlayModuleAPI<HTMLImageElement>
 */
class ImageMaskOverlay implements IMediaOverlay {
  private imageStates = new WeakMap<HTMLImageElement, IMediaOverlayState>();

  createMaskOverlay(image: HTMLImageElement, imagePrediction: IImagePrediction, hostSettings: IHostSettings): void {
    if (!imagePrediction.predictions.length || !image.complete || image.naturalWidth === 0) {
      this.clearMaskOverlay(image);
      return;
    }

    registerQuickToggle(image, imagePrediction, hostSettings);

    if (!shouldBlock(imagePrediction)) {
      this.hideMaskVisual(image);
      return;
    }

    // If we already manage an overlay for this image, just update/redraw
    const existingState = this.imageStates.get(image);
    if (existingState && !existingState.destroyed) {
      existingState.currentPrediction = imagePrediction;
      existingState.canvas.style.display = '';
      this.render(image, existingState);
      return;
    }

    // Remove legacy overlays created by pre-layer versions of this module (one-time cleanup)
    removeExistingImageOverlays(image.parentElement);

    const decodedMasks = decodePredictionMasks(imagePrediction);
    if (decodedMasks.length === 0) return;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = CANVAS_STYLE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      logger.withTag('maskOverlay').error('Failed to get canvas context');
      return;
    }

    const state: IMediaOverlayState = {
      canvas,
      ctx,
      lastSize: { width: 0, height: 0 },
      destroyed: false,
      currentPrediction: imagePrediction,
      trackedSrc: image.currentSrc || image.src,
      masking: hostSettings.masking,
      decodedMasks,
      decodedFor: imagePrediction,
      // assigned below; attach() fires the initial geometry callback synchronously
      // and the callback does not touch state.slot
      slot: undefined as unknown as IMediaOverlayState['slot'],
    };
    this.imageStates.set(image, state);

    state.slot = overlayLayer.attach(
      image,
      {
        onGeometry: geometry => this.handleGeometry(image, state, geometry),
        onDetach: () => this.teardown(image, state, { releaseSlot: false }),
      },
      'image-mask',
    );
    state.slot.root.appendChild(canvas);
  }

  /**
   * Hides the visual mask without releasing the slot or the eye-toggle registration.
   * Used when the user toggles masking off; toggling back on redraws into the same slot.
   */
  private hideMaskVisual(image: HTMLImageElement): void {
    const state = this.imageStates.get(image);
    if (state) {
      state.canvas.style.display = 'none';
    }
  }

  /**
   * Clears mask overlay for image elements.
   */
  clearMaskOverlay(image: HTMLImageElement): void {
    const state = this.imageStates.get(image);
    if (state) {
      this.teardown(image, state, { releaseSlot: true });
    }
    // Unregister from eye toggle
    unregisterQuickToggle(image);
  }

  /**
   * Checks if image has an active mask overlay.
   */
  hasMaskOverlay(image: HTMLImageElement): boolean {
    return this.imageStates.has(image);
  }

  private teardown(image: HTMLImageElement, state: IMediaOverlayState, opts: { releaseSlot: boolean }): void {
    state.destroyed = true;
    if (opts.releaseSlot) state.slot?.release();
    this.imageStates.delete(image);
  }

  private handleGeometry(image: HTMLImageElement, state: IMediaOverlayState, { rect }: ILayerGeometry): void {
    if (state.destroyed) return;

    // Self-clean if src changed
    const currentSrc = image.currentSrc || image.src;
    if (state.trackedSrc && currentSrc !== state.trackedSrc) {
      this.clearMaskOverlay(image);
      return;
    }

    // The layer already moved the slot; only a size change requires a redraw.
    if (rect.width === state.lastSize.width && rect.height === state.lastSize.height) return;
    state.lastSize = { width: rect.width, height: rect.height };
    this.render(image, state);
  }

  private render(image: HTMLImageElement, state: IMediaOverlayState): void {
    const imagePrediction = state.currentPrediction;
    if (!imagePrediction || !imagePrediction.predictions.length) {
      this.clearMaskOverlay(image);
      return;
    }
    if (state.destroyed) return;
    const { width, height } = state.lastSize;
    if (width <= 0 || height <= 0) return;

    // Refresh the decoded-mask cache if the prediction was replaced
    if (state.decodedFor !== imagePrediction) {
      state.decodedMasks = decodePredictionMasks(imagePrediction);
      state.decodedFor = imagePrediction;
    }
    if (!state.decodedMasks?.length) return;

    const contentRect = computeRenderedContentRect(image, state.lastSize);
    logRenderSnapshot(image, state, contentRect);

    renderUnifiedCanvasMask(
      state.canvas,
      state.ctx,
      state.decodedMasks,
      imagePrediction.maskTransform,
      imagePrediction.width,
      imagePrediction.height,
      width, // overlay (element) width
      height, // overlay (element) height
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
  if (overlayWidth <= 0 || overlayHeight <= 0) return;
  if (contentWidth <= 0 || contentHeight <= 0) return;

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

  // Use the entire natural image dimensions for proper scaling
  tctx.drawImage(
    image,
    0,
    0,
    image.naturalWidth,
    image.naturalHeight, // source rect (entire natural image)
    0,
    0,
    smallW,
    smallH, // destination rect (small canvas)
  );

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

// Removes overlays that pre-layer versions of this module injected into site DOM
// (extension updated while the page was open).
const removeExistingImageOverlays = (parent: HTMLElement | null): void => {
  if (!parent) return;
  const existingOverlays = parent.querySelectorAll('[data-mask-overlay]');
  existingOverlays.forEach(overlay => overlay.remove());
};

// Export singleton instance
export const imageMaskOverlay = new ImageMaskOverlay();
