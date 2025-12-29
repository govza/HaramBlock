import { computeRenderedContentRect } from '@/entrypoints/content/presentation/imageLayout';
import { registerQuickToggle, unregisterQuickToggle } from '@/entrypoints/content/presentation/quickToggle';

import type { IElementPrediction, IHostSettings, IImagePrediction } from '@/utils/types';

type BlurOverlayState = {
  resizeObserver: ResizeObserver | null;
  viewportHandler: (() => void) | null;
  currentPrediction: IImagePrediction | undefined;
  parent: HTMLElement | null;
};

const blurStates = new WeakMap<HTMLImageElement | HTMLVideoElement, BlurOverlayState>();

/**
 * Helper to check if media element is ready for overlay rendering
 */
function isMediaReady(element: HTMLImageElement | HTMLVideoElement): boolean {
  if (element instanceof HTMLImageElement) {
    return element.complete && element.naturalWidth > 0;
  } else {
    return element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && element.videoWidth > 0;
  }
}

/**
 * Helper to get natural dimensions of media element
 */
function getNaturalDimensions(element: HTMLImageElement | HTMLVideoElement): { width: number; height: number } {
  if (element instanceof HTMLImageElement) {
    return { width: element.naturalWidth, height: element.naturalHeight };
  } else {
    return { width: element.videoWidth, height: element.videoHeight };
  }
}

export const createBlurBoxOverlays = (
  element: HTMLImageElement | HTMLVideoElement,
  imagePrediction: IImagePrediction,
  hostSettings: IHostSettings,
): void => {
  const parent = element.parentElement;
  if (!parent) return;

  if (!imagePrediction.predictions?.length || !isMediaReady(element)) {
    clearBlurBoxOverlay(element);
    return;
  }

  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  const state =
    blurStates.get(element) ??
    ({ resizeObserver: null, viewportHandler: null, currentPrediction: undefined, parent: null } as BlurOverlayState);
  state.currentPrediction = imagePrediction;
  state.parent = parent;
  blurStates.set(element, state);

  registerQuickToggle(element, imagePrediction, hostSettings.quickToggle);

  // Skip blur boxes if user unmasked this image
  if (imagePrediction.isUnmasked) {
    removeBlurBoxOverlays(element);
    return;
  }

  const render = () => {
    // Always use the latest prediction from state
    const pred = blurStates.get(element)?.currentPrediction;
    const predictions = pred?.predictions || [];
    removeBlurBoxOverlays(element);
    if (!pred || !predictions.length || pred.isUnmasked) return;

    const elementRect = element.getBoundingClientRect();
    const contentRect = computeRenderedContentRect(element, elementRect);
    const parentRect = parent.getBoundingClientRect();

    const visibleLeft = Math.max(elementRect.left, parentRect.left);
    const visibleTop = Math.max(elementRect.top, parentRect.top);
    const visibleRight = Math.min(elementRect.right, parentRect.right);
    const visibleBottom = Math.min(elementRect.bottom, parentRect.bottom);
    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return;

    const elementOffsetX = elementRect.left - parentRect.left + contentRect.offsetX;
    const elementOffsetY = elementRect.top - parentRect.top + contentRect.offsetY;

    const { width: naturalWidth, height: naturalHeight } = getNaturalDimensions(element);
    const originalWidth = pred.width ?? naturalWidth;
    const originalHeight = pred.height ?? naturalHeight;
    const scaleX = contentRect.width / originalWidth;
    const scaleY = contentRect.height / originalHeight;

    predictions.forEach((prediction: IElementPrediction) => {
      const { x, y, width, height } = prediction.boundingBox;
      const boxLeft = elementOffsetX + x * scaleX;
      const boxTop = elementOffsetY + y * scaleY;
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

  // Setup observers once per element
  if (!state.resizeObserver) {
    state.resizeObserver = new ResizeObserver(() => render());
    state.resizeObserver.observe(element);
  }
  if (!state.viewportHandler) {
    state.viewportHandler = () => render();
    globalThis.addEventListener('resize', state.viewportHandler);
    globalThis.addEventListener('scroll', state.viewportHandler, { passive: true } as AddEventListenerOptions);
  }
};

export const removeBlurBoxOverlays = (element: HTMLImageElement | HTMLVideoElement): void => {
  // Prefer stored parent from state when available (works even if element is detached)
  const state = blurStates.get(element);
  const parent = state?.parent ?? element.parentElement;
  if (!parent) return;
  const blurBoxes = parent.querySelectorAll('.haramblock-blur-box');
  blurBoxes.forEach(box => box.remove());
};

export const clearBlurBoxOverlay = (element: HTMLImageElement | HTMLVideoElement): void => {
  const state = blurStates.get(element);
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
    blurStates.delete(element);
  }
  // Unregister from eye toggle
  unregisterQuickToggle(element);
  // Fallback removal using current parent if available
  removeBlurBoxOverlays(element);
};

export const hasBlurBoxOverlay = (element: HTMLImageElement | HTMLVideoElement): boolean => {
  return blurStates.has(element) || false;
};
