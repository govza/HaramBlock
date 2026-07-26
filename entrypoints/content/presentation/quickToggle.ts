import { EYE_AUTO_PATH, EYE_BLOCKED_PATH, EYE_VISIBLE_PATH } from '@/components/ui/icons';
import { computeRenderedContentRect, type ContentRect } from '@/entrypoints/content/presentation/imageLayout';
import { ensurePositionContext, overlayOffsetInParent } from '@/entrypoints/content/presentation/overlayPosition';

import type { ForcedVisibility, IHostSettings, IImagePrediction } from '@/utils/types';

// Delay before showing button after hovering an image
const SHOW_DELAY_MS = 500;
// Delay before hiding button after mouse leaves
const HIDE_DELAY_MS = 2500;

// Chrome is sized in px, not rem: placement math and the rendered button must
// agree even on sites with a non-16px root font size
const BUTTON_SIZE_PX = 32;
const BUTTON_MARGIN_PX = 8;

type ToggleCallback = (src: string, forcedVisibility: ForcedVisibility) => void;
type RegisteredElement = {
  prediction: IImagePrediction;
  minSize: IHostSettings['minSize'];
};

let eyeButton: HTMLButtonElement | null = null;
let currentElement: HTMLImageElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let toggleCallback: ToggleCallback | null = null;

const registeredElements = new WeakMap<HTMLImageElement, RegisteredElement>();

function getNextState(current: ForcedVisibility): ForcedVisibility {
  // Both unsafe and safe: auto → blocked → visible → auto
  if (current === 'auto') return 'blocked';
  if (current === 'blocked') return 'visible';
  return 'auto';
}

function createSvgIcon(nextState: ForcedVisibility): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'white');
  // Inline (not via the injected class rules): inside shadow trees the
  // document-level stylesheet never applies
  svg.style.cssText = 'width: 20px; height: 20px; opacity: 0.5;';

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  if (nextState === 'visible') {
    path.setAttribute('d', EYE_VISIBLE_PATH);
  } else if (nextState === 'blocked') {
    path.setAttribute('d', EYE_BLOCKED_PATH);
  } else {
    path.setAttribute('d', EYE_AUTO_PATH);
  }

  svg.appendChild(path);
  return svg;
}

function updateButtonIcon(prediction: IImagePrediction): void {
  if (!eyeButton) return;
  eyeButton.replaceChildren(createSvgIcon(getNextState(prediction.forcedVisibility)));
}

/**
 * Absolute offset (in the parent's content coordinates) of the eye button at
 * the top-right of the picture — the rendered content, not the element box,
 * so letterbox bars in contain-fit lightboxes never receive the button.
 * Clamped so a picture narrower than the button still anchors it at its own
 * left edge instead of a neighbour's.
 */
export function eyeButtonOffsetInParent(
  imageOffset: { top: number; left: number },
  contentRect: ContentRect,
  buttonSize: number,
  margin: number,
): { top: number; left: number } {
  const contentLeft = imageOffset.left + contentRect.offsetX;
  return {
    top: imageOffset.top + contentRect.offsetY + margin,
    left: Math.max(contentLeft, contentLeft + contentRect.width - buttonSize - margin),
  };
}

/**
 * Inserts the button next to the image (like the mask overlay) and positions
 * it at the picture's top-right corner. Living in the image's own stacking
 * context is what makes occlusion correct: a lightbox backdrop that covers
 * the image covers the button too, and scrolling moves both together.
 */
function positionEye(element: HTMLImageElement): boolean {
  if (!eyeButton) return false;
  const parent = element.parentElement;
  if (!parent) return false;

  ensurePositionContext(parent);

  const imageRect = element.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const imageOffset = overlayOffsetInParent(parent, imageRect, parentRect);
  const contentRect = computeRenderedContentRect(element, imageRect);
  const offset = eyeButtonOffsetInParent(imageOffset, contentRect, BUTTON_SIZE_PX, BUTTON_MARGIN_PX);

  eyeButton.style.top = `${offset.top}px`;
  eyeButton.style.left = `${offset.left}px`;
  // Just above the image and its mask overlay (image + 1) — never a large
  // fixed value: `position: relative` on the parent does not create a
  // stacking context, so a big z-index would float the button over real
  // lightbox backdrops in the root stacking context
  const imageZIndex = parseInt(getComputedStyle(element).zIndex) || 0;
  eyeButton.style.zIndex = String(imageZIndex + 2);
  if (eyeButton.parentElement !== parent) parent.appendChild(eyeButton);
  return true;
}

function showEye(element: HTMLImageElement): void {
  createGlobalEyeButton();
  if (!eyeButton) return;

  const registered = registeredElements.get(element);
  if (!registered) return;

  if (element.clientWidth < registered.minSize.width || element.clientHeight < registered.minSize.height) return;

  // Hide first when switching to a new element
  eyeButton.style.display = 'none';
  clearHideTimer();
  clearShowTimer();

  currentElement = element;
  updateButtonIcon(registered.prediction);
  if (!positionEye(element)) return;

  showTimer = setTimeout(() => {
    showTimer = null;
    if (currentElement !== element || !eyeButton) return;
    // Re-anchor before revealing: a lightbox may still be zooming/centering
    // during the show delay, which would leave the snapshot position stale
    if (!positionEye(element)) return;
    eyeButton.style.display = 'flex';
    resetHideTimer();
  }, SHOW_DELAY_MS);
}

function hideEye(): void {
  if (!eyeButton) return;
  clearShowTimer();
  eyeButton.style.display = 'none';
  // Never park the hidden button inside a site's container — a foreign child
  // left behind can break the site's own child selectors and re-renders
  eyeButton.remove();
  currentElement = null;
}

function resetHideTimer(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hideEye, HIDE_DELAY_MS);
}

function clearHideTimer(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function clearShowTimer(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

function handleClick(e: Event): void {
  e.preventDefault();
  e.stopPropagation();

  if (!currentElement) return;
  const registered = registeredElements.get(currentElement);
  if (!registered) return;

  // Save element reference - toggleCallback may unregister/re-register
  const clickedElement = currentElement;
  const nextForcedVisibility = getNextState(registered.prediction.forcedVisibility);

  if (toggleCallback) {
    toggleCallback(registered.prediction.src, nextForcedVisibility);
  }

  // After toggle, get fresh registered data and keep eye visible
  const freshRegistered = registeredElements.get(clickedElement);
  if (freshRegistered) {
    if (
      clickedElement.clientWidth < freshRegistered.minSize.width ||
      clickedElement.clientHeight < freshRegistered.minSize.height
    ) {
      hideEye();
      return;
    }
    currentElement = clickedElement;
    updateButtonIcon(freshRegistered.prediction);
    if (!positionEye(clickedElement)) {
      hideEye();
      return;
    }
    if (eyeButton) {
      eyeButton.style.display = 'flex';
    }
  }
  resetHideTimer();
}

function handlePointerEnter(e: Event): void {
  const target = e.currentTarget as HTMLImageElement;
  if (registeredElements.has(target)) {
    showEye(target);
  }
}

function handlePointerLeave(): void {
  resetHideTimer();
}

function createGlobalEyeButton(): void {
  if (eyeButton) return;

  eyeButton = document.createElement('button');
  eyeButton.className = 'haramblock-eye-toggle';
  // Full chrome inline for the same reason as the mask overlay: the button is
  // inserted into arbitrary site parents (possibly inside shadow trees) where
  // the injected class rules may not reach
  eyeButton.style.cssText = `
    position: absolute;
    display: none;
    width: ${BUTTON_SIZE_PX}px;
    height: ${BUTTON_SIZE_PX}px;
    padding: 4px;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.5);
    cursor: pointer;
    align-items: center;
    justify-content: center;
  `;
  eyeButton.appendChild(createSvgIcon('blocked'));

  eyeButton.addEventListener('click', handleClick);
  eyeButton.addEventListener('pointerenter', () => clearHideTimer());
  eyeButton.addEventListener('pointerleave', () => resetHideTimer());
}

export function initQuickToggle(onToggle: ToggleCallback): void {
  toggleCallback = onToggle;
  createGlobalEyeButton();
}

export function registerQuickToggle(
  element: HTMLImageElement,
  prediction: IImagePrediction,
  hostSettings: IHostSettings,
): void {
  const { quickToggle, minSize } = hostSettings;
  const hasPredictions = Boolean(prediction.predictions?.length);
  const shouldRegister = hasPredictions ? quickToggle.unsafeEnabled : quickToggle.safeEnabled;
  if (!shouldRegister) return;

  const existing = registeredElements.get(element);
  if (existing) {
    existing.prediction = prediction;
    existing.minSize = minSize;
    return;
  }

  registeredElements.set(element, { prediction, minSize });

  element.addEventListener('pointerenter', handlePointerEnter);
  element.addEventListener('pointerleave', handlePointerLeave);
}

export function unregisterQuickToggle(element: HTMLImageElement): void {
  registeredElements.delete(element);
  element.removeEventListener('pointerenter', handlePointerEnter);
  element.removeEventListener('pointerleave', handlePointerLeave);

  if (currentElement === element) {
    hideEye();
  }
}

export function destroyQuickToggle(): void {
  clearHideTimer();
  clearShowTimer();

  if (eyeButton) {
    eyeButton.remove();
    eyeButton = null;
  }

  currentElement = null;
  toggleCallback = null;
}
