import { IMAGE_MASK_OVERLAY_ATTR } from '@/entrypoints/content/presentation/constants';
import { type ContentRect } from '@/entrypoints/content/presentation/imageLayout';
import { hasInitialStyling } from '@/entrypoints/content/presentation/initialStyling';
import { MaskCoverage, paintPixelatedMask } from '@/entrypoints/content/presentation/maskCoverage';
import {
  anchorOverlay,
  type OverlayAnchor,
  type OverlayGeometry,
} from '@/entrypoints/content/presentation/overlayAnchor';
import {
  predictionToggleRegistration,
  registerQuickToggle,
  unregisterQuickToggle,
} from '@/entrypoints/content/presentation/quickToggle';
import { getLogger } from '@/utils/telemetry';
import { shouldBlock, type IHostSettings, type IImagePrediction, type IMaskingSettings } from '@/utils/types';

const log = getLogger('imageMaskOverlay');

/**
 * An image the site already blurs at least as strongly as our own pending blur (decorative
 * background copies) is protected to our standard; an opaque pixelated mask on top would be more
 * visible than the original, so ours hides while the site's blur holds. Our own protective styling
 * contributes the same computed filter and must not count — it is stripped once the overlay is up.
 */
const SITE_OBSCURING_MIN_BLUR_PX = 15;

const isObscuredBySite = (image: HTMLImageElement): boolean => {
  if (hasInitialStyling(image)) return false;
  const radius = /blur\((\d+(?:\.\d+)?)px\)/.exec(getComputedStyle(image).filter)?.[1];
  return radius !== undefined && parseFloat(radius) >= SITE_OBSCURING_MIN_BLUR_PX;
};

/**
 * One masked image: its anchored overlay, the canvas context it paints into, and the prediction
 * and masking settings the next paint uses.
 */
interface ImageMaskState {
  overlay: HTMLDivElement;
  ctx: CanvasRenderingContext2D;
  anchor: OverlayAnchor;
  prediction: IImagePrediction;
  masking: IMaskingSettings;
}

const imageStates = new WeakMap<HTMLImageElement, ImageMaskState>();

const coverageOf = (imagePrediction: IImagePrediction): MaskCoverage | null =>
  MaskCoverage.from(
    imagePrediction.predictions,
    imagePrediction.maskTransform,
    imagePrediction.width,
    imagePrediction.height,
  );

/**
 * Sizes the overlay canvas to the element box before painting. A collapsed element (e.g. hidden by a
 * lightbox) drops the previous frame too: a stale painted canvas would keep showing at its old size.
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

const paint = (image: HTMLImageElement, geometry: OverlayGeometry): void => {
  const state = imageStates.get(image);
  if (!state) return;
  state.overlay.style.display = isObscuredBySite(image) ? 'none' : '';
  const coverage = coverageOf(state.prediction);
  if (!coverage) return;
  renderUnifiedCanvasMask(state.ctx, image, coverage, geometry, geometry.content, state.masking);
};

/**
 * Full teardown, never a detached-but-kept state: a live anchor would re-home the overlay right
 * back on the next site mutation. Re-masking goes through the create path.
 */
const disposeState = (image: HTMLImageElement): void => {
  imageStates.get(image)?.anchor.dispose();
  imageStates.delete(image);
};

const clearMaskOverlay = (image: HTMLImageElement): void => {
  disposeState(image);
  unregisterQuickToggle(image);
};

const createState = (
  image: HTMLImageElement,
  prediction: IImagePrediction,
  masking: IMaskingSettings,
): ImageMaskState | null => {
  const overlay = document.createElement('div');
  overlay.setAttribute(IMAGE_MASK_OVERLAY_ATTR, 'unified-mask-overlay');
  overlay.style.cssText = 'position: absolute; overflow: hidden; pointer-events: none;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  `;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    log.error('overlay.canvas_context.failed', { canvas: 'main' });
    return null;
  }
  overlay.appendChild(canvas);

  const anchor = anchorOverlay(image, overlay, {
    trackSrc: true,
    onLayout: geometry => paint(image, geometry),
    onLost: reason => {
      if (reason === 'src-drift') {
        clearMaskOverlay(image);
      } else {
        disposeState(image);
      }
    },
  });
  return { overlay, ctx, anchor, prediction, masking };
};

const createMaskOverlay = (
  image: HTMLImageElement,
  prediction: IImagePrediction,
  hostSettings: IHostSettings,
): void => {
  if (!prediction.predictions.length || !image.complete || image.naturalWidth === 0) {
    clearMaskOverlay(image);
    return;
  }

  registerQuickToggle(image, predictionToggleRegistration(prediction, hostSettings));

  if (!shouldBlock(prediction)) {
    disposeState(image);
    return;
  }

  const existing = imageStates.get(image);
  if (existing) {
    existing.prediction = prediction;
    existing.masking = hostSettings.masking;
    existing.anchor.refresh();
    return;
  }

  if (!coverageOf(prediction)) return;
  const state = createState(image, prediction, hostSettings.masking);
  if (!state) return;
  imageStates.set(image, state);
  state.anchor.refresh();
};

/**
 * A state whose overlay is off the page (its image detached and not yet back) does not count:
 * reporting it as active would block the processing pass that could recreate it.
 */
const hasMaskOverlay = (image: HTMLImageElement): boolean => imageStates.get(image)?.overlay.isConnected ?? false;

export const imageMaskOverlay = { createMaskOverlay, clearMaskOverlay, hasMaskOverlay };
