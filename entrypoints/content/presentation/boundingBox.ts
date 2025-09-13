import { computeRenderedContentRect } from '@/entrypoints/content/presentation/imageLayout';

import type { IElementPrediction, IImagePrediction } from '@/utils/types';

type BlurOverlayState = {
  resizeObserver: ResizeObserver | null;
  viewportHandler: (() => void) | null;
  currentPrediction: IImagePrediction | undefined;
  parent: HTMLElement | null;
};

const blurStates = new WeakMap<HTMLImageElement, BlurOverlayState>();

export const createBlurBoxOverlays = (image: HTMLImageElement, imagePrediction?: IImagePrediction): void => {
  const parent = image.parentElement;
  if (!parent) return;

  if (!imagePrediction || !imagePrediction.predictions?.length || !image.complete || image.naturalWidth === 0) {
    clearBlurBoxOverlay(image);
    return;
  }

  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  const state =
    blurStates.get(image) ??
    ({ resizeObserver: null, viewportHandler: null, currentPrediction: undefined, parent: null } as BlurOverlayState);
  state.currentPrediction = imagePrediction;
  state.parent = parent;
  blurStates.set(image, state);

  const render = () => {
    // Always use the latest prediction from state
    const pred = blurStates.get(image)?.currentPrediction;
    const predictions = pred?.predictions || [];
    removeBlurBoxOverlays(image);
    if (!pred || !predictions.length) return;

    const imageRect = image.getBoundingClientRect();
    const contentRect = computeRenderedContentRect(image, imageRect);
    const parentRect = parent.getBoundingClientRect();

    const visibleLeft = Math.max(imageRect.left, parentRect.left);
    const visibleTop = Math.max(imageRect.top, parentRect.top);
    const visibleRight = Math.min(imageRect.right, parentRect.right);
    const visibleBottom = Math.min(imageRect.bottom, parentRect.bottom);
    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return;

    const imageOffsetX = imageRect.left - parentRect.left + contentRect.offsetX;
    const imageOffsetY = imageRect.top - parentRect.top + contentRect.offsetY;

    const originalWidth = pred.imageWidth ?? image.naturalWidth;
    const originalHeight = pred.imageHeight ?? image.naturalHeight;
    const scaleX = contentRect.width / originalWidth;
    const scaleY = contentRect.height / originalHeight;

    predictions.forEach((prediction: IElementPrediction) => {
      const { x, y, width, height } = prediction.boundingBox;
      const boxLeft = imageOffsetX + x * scaleX;
      const boxTop = imageOffsetY + y * scaleY;
      const boxWidth = width * scaleX;
      const boxHeight = height * scaleY;

      const clippedLeft = Math.max(boxLeft, visibleLeft - parentRect.left);
      const clippedTop = Math.max(boxTop, visibleTop - parentRect.top);
      const clippedRight = Math.min(boxLeft + boxWidth, visibleRight - parentRect.left);
      const clippedBottom = Math.min(boxTop + boxHeight, visibleBottom - parentRect.top);

      if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return;

      const blurBox = document.createElement('div');
      blurBox.className = 'haramblock-blur-box';
      blurBox.style.left = `${clippedLeft}px`;
      blurBox.style.top = `${clippedTop}px`;
      blurBox.style.width = `${clippedRight - clippedLeft}px`;
      blurBox.style.height = `${clippedBottom - clippedTop}px`;
      parent.appendChild(blurBox);
    });
  };

  // Initial render for current predictions
  render();

  // Setup observers once per image
  if (!state.resizeObserver) {
    state.resizeObserver = new ResizeObserver(() => render());
    state.resizeObserver.observe(image);
  }
  if (!state.viewportHandler) {
    state.viewportHandler = () => render();
    globalThis.addEventListener('resize', state.viewportHandler);
    globalThis.addEventListener('scroll', state.viewportHandler, { passive: true } as AddEventListenerOptions);
  }
};

export const removeBlurBoxOverlays = (image: HTMLImageElement): void => {
  // Prefer stored parent from state when available (works even if image is detached)
  const state = blurStates.get(image);
  const parent = state?.parent ?? image.parentElement;
  if (!parent) return;
  const blurBoxes = parent.querySelectorAll('.haramblock-blur-box');
  blurBoxes.forEach(box => box.remove());
};

export const clearBlurBoxOverlay = (image: HTMLImageElement): void => {
  const state = blurStates.get(image);
  if (state) {
    try {
      state.resizeObserver?.disconnect();
    } catch {
      // no-op
    }
    if (state.viewportHandler) {
      globalThis.removeEventListener('resize', state.viewportHandler);
      globalThis.removeEventListener('scroll', state.viewportHandler);
    }
    // Remove any existing blur boxes from the stored parent (if present)
    if (state.parent) {
      const blurBoxes = state.parent.querySelectorAll('.haramblock-blur-box');
      blurBoxes.forEach(box => box.remove());
    }
    blurStates.delete(image);
  }
  // Fallback removal using current parent if available
  removeBlurBoxOverlays(image);
};
