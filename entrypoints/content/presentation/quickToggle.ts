import { EYE_AUTO_PATH, EYE_BLOCKED_PATH, EYE_VISIBLE_PATH } from '@/components/ui/icons';
import {
  clipContentRectToBox,
  computeRenderedContentRect,
  type ContentRect,
} from '@/entrypoints/content/presentation/imageLayout';
import {
  ensurePositionContext,
  overlayPlacement,
  resolveAnchorParent,
} from '@/entrypoints/content/presentation/overlayPosition';

import type { ForcedVisibility, IHostSettings } from '@/utils/types';

// Delay before showing button after hovering an image
const SHOW_DELAY_MS = 500;
// Delay before hiding button after mouse leaves
const HIDE_DELAY_MS = 2500;

// px, not rem: placement math and rendered size must agree on non-16px root font sizes
const BUTTON_SIZE_PX = 32;
const BUTTON_MARGIN_PX = 8;

type ToggleCallback = (src: string, forcedVisibility: ForcedVisibility) => void;
export type ToggleTarget = HTMLImageElement | HTMLVideoElement;
type RegisteredElement = {
  src: string;
  forcedVisibility: ForcedVisibility;
  hasDetections: boolean;
  /** The pipeline finalized without analyzing this element (e.g. undelayable video). */
  unprocessed: boolean;
  minSize: IHostSettings['minSize'];
  /** Per-element handler (videos): session-scoped state has no src-keyed store to route through. */
  onToggle?: (next: ForcedVisibility) => void;
};

let eyeButton: HTMLButtonElement | null = null;
let currentElement: ToggleTarget | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let toggleCallback: ToggleCallback | null = null;

const registeredElements = new WeakMap<ToggleTarget, RegisteredElement>();

/** Unprocessed elements skip 'visible': they already show unprotected, so only auto ↔ blocked remain meaningful. */
export function nextToggleState(current: ForcedVisibility, unprocessed: boolean): ForcedVisibility {
  if (unprocessed) return current === 'auto' ? 'blocked' : 'auto';
  if (current === 'auto') return 'blocked';
  if (current === 'blocked') return 'visible';
  return 'auto';
}

function createSvgIcon(nextState: ForcedVisibility, fill = 'white'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', fill);
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

const DEFAULT_BUTTON_BACKGROUND = 'rgba(0, 0, 0, 0.5)';
/** Inverted (white) button marks an element the AI never analyzed. */
const UNPROCESSED_BUTTON_BACKGROUND = 'rgba(255, 255, 255, 0.7)';

function updateButtonAppearance(registered: RegisteredElement): void {
  if (!eyeButton) return;
  const showUnprocessed = registered.unprocessed && registered.forcedVisibility === 'auto';
  eyeButton.replaceChildren(
    createSvgIcon(
      nextToggleState(registered.forcedVisibility, registered.unprocessed),
      showUnprocessed ? 'black' : 'white',
    ),
  );
  eyeButton.style.background = showUnprocessed ? UNPROCESSED_BUTTON_BACKGROUND : DEFAULT_BUTTON_BACKGROUND;
}

// Anchors to the rendered content, not the element box: letterbox bars in
// contain-fit lightboxes must never receive the button
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

function positionEye(element: ToggleTarget): boolean {
  if (!eyeButton) return false;
  const parent = resolveAnchorParent(element);
  if (!parent) return false;

  ensurePositionContext(parent);

  const imageRect = element.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const placement = overlayPlacement(element, parent, imageRect, parentRect);
  // Clip cover-fit crop overflow: an overflow-hidden parent would clip a button
  // anchored past the element box into an unclickable sliver
  const contentRect = clipContentRectToBox(
    computeRenderedContentRect(element, imageRect),
    imageRect.width,
    imageRect.height,
  );
  const offset = eyeButtonOffsetInParent(placement, contentRect, BUTTON_SIZE_PX, BUTTON_MARGIN_PX);

  eyeButton.style.position = placement.position;
  eyeButton.style.top = `${offset.top}px`;
  eyeButton.style.left = `${offset.left}px`;
  // The parent creates no stacking context, so a large z-index would float
  // over real lightbox backdrops; stay just above the image's mask overlay
  const imageZIndex = parseInt(getComputedStyle(element).zIndex) || 0;
  eyeButton.style.zIndex = String(imageZIndex + 2);
  if (eyeButton.parentElement !== parent) parent.appendChild(eyeButton);
  return true;
}

function showEye(element: ToggleTarget): void {
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
  updateButtonAppearance(registered);
  if (!positionEye(element)) return;

  showTimer = setTimeout(() => {
    showTimer = null;
    if (currentElement !== element || !eyeButton) return;
    // Re-anchor: a lightbox may still be zooming/centering during the show delay
    if (!positionEye(element)) return;
    eyeButton.style.display = 'flex';
    resetHideTimer();
  }, SHOW_DELAY_MS);
}

function hideEye(): void {
  if (!eyeButton) return;
  clearShowTimer();
  eyeButton.style.display = 'none';
  // A parked foreign child can break the site's own child selectors
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

  // Save element reference - the toggle handler may unregister/re-register
  const clickedElement = currentElement;
  const nextForcedVisibility = nextToggleState(registered.forcedVisibility, registered.unprocessed);

  if (registered.onToggle) {
    registered.onToggle(nextForcedVisibility);
  } else if (toggleCallback) {
    toggleCallback(registered.src, nextForcedVisibility);
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
    updateButtonAppearance(freshRegistered);
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
  const target = e.currentTarget as ToggleTarget;
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
  // Inline chrome: the injected class rules cannot reach shadow trees
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

function upsertRegistration(element: ToggleTarget, entry: RegisteredElement): void {
  const existing = registeredElements.get(element);
  if (existing) {
    Object.assign(existing, entry);
    return;
  }

  registeredElements.set(element, entry);

  element.addEventListener('pointerenter', handlePointerEnter);
  element.addEventListener('pointerleave', handlePointerLeave);
}

/**
 * Which host switch governs the button. A forced element must keep its button
 * (either switch suffices) or the user could never cycle back to 'auto'.
 */
export function shouldShowToggle(
  forcedVisibility: ForcedVisibility,
  hasDetections: boolean,
  quickToggle: IHostSettings['quickToggle'],
): boolean {
  if (forcedVisibility !== 'auto') return quickToggle.unsafeEnabled || quickToggle.safeEnabled;
  return hasDetections ? quickToggle.unsafeEnabled : quickToggle.safeEnabled;
}

export interface QuickToggleRegistration {
  src: string;
  forcedVisibility: ForcedVisibility;
  hasDetections: boolean;
  /** The pipeline finalized without analyzing this element; the button shows an amber warning. */
  unprocessed?: boolean;
  hostSettings: IHostSettings;
  /** Per-element handler; omitted = the global src-keyed callback from initQuickToggle. */
  onToggle?: (next: ForcedVisibility) => void;
}

/** Adapter for prediction-driven (src-keyed) elements; structural so this module stays prediction-agnostic. */
export function predictionToggleRegistration(
  prediction: { src: string; forcedVisibility: ForcedVisibility; predictions?: readonly unknown[] },
  hostSettings: IHostSettings,
): QuickToggleRegistration {
  return {
    src: prediction.src,
    forcedVisibility: prediction.forcedVisibility,
    hasDetections: Boolean(prediction.predictions?.length),
    hostSettings,
  };
}

export function registerQuickToggle(element: ToggleTarget, opts: QuickToggleRegistration): void {
  const { quickToggle, minSize } = opts.hostSettings;
  if (!shouldShowToggle(opts.forcedVisibility, opts.hasDetections, quickToggle)) {
    unregisterQuickToggle(element);
    return;
  }

  upsertRegistration(element, {
    src: opts.src,
    forcedVisibility: opts.forcedVisibility,
    hasDetections: opts.hasDetections,
    unprocessed: opts.unprocessed ?? false,
    minSize,
    onToggle: opts.onToggle,
  });
}

export function unregisterQuickToggle(element: ToggleTarget): void {
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
