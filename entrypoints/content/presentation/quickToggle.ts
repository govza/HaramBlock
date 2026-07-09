import { EYE_AUTO_PATH, EYE_BLOCKED_PATH, EYE_VISIBLE_PATH } from '@/components/ui/icons';

import type { ForcedVisibility, IHostSettings, IImagePrediction } from '@/utils/types';

// Delay before showing button after hovering an image
const SHOW_DELAY_MS = 500;
// Delay before hiding button after mouse leaves
const HIDE_DELAY_MS = 2500;

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
let pendingAttachOnReady = false;

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

function positionEye(element: HTMLElement): void {
  if (!eyeButton) return;

  const rect = element.getBoundingClientRect();
  const { clientWidth: viewportWidth } = document.documentElement;

  // Position at top-right of element
  const top = rect.top < 0 ? 0 : rect.top;
  let left = rect.right - 32; // Button width is 2rem ≈ 32px
  if (left + 32 > viewportWidth) left = viewportWidth - 32;
  if (left < rect.left) left = Math.min(Math.max(rect.left, 0), viewportWidth - 32);

  eyeButton.style.top = `${top + 8}px`;
  eyeButton.style.left = `${left - 8}px`;
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
  positionEye(element);

  showTimer = setTimeout(() => {
    showTimer = null;
    if (currentElement === element && eyeButton) {
      eyeButton.style.display = 'flex';
      resetHideTimer();
    }
  }, SHOW_DELAY_MS);
}

function hideEye(): void {
  if (!eyeButton) return;
  clearShowTimer();
  eyeButton.style.display = 'none';
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
    positionEye(clickedElement);
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

function attachEyeButton(): void {
  if (!eyeButton || eyeButton.isConnected) return;

  if (!document.body) {
    if (pendingAttachOnReady) return;
    pendingAttachOnReady = true;
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        pendingAttachOnReady = false;
        attachEyeButton();
      },
      { once: true },
    );
    return;
  }

  document.body.appendChild(eyeButton);
}

function createGlobalEyeButton(): void {
  if (eyeButton) {
    attachEyeButton();
    return;
  }

  eyeButton = document.createElement('button');
  eyeButton.className = 'haramblock-eye-toggle';
  eyeButton.style.position = 'fixed';
  eyeButton.style.display = 'none';
  eyeButton.appendChild(createSvgIcon('blocked'));

  eyeButton.addEventListener('click', handleClick);
  eyeButton.addEventListener('pointerenter', () => clearHideTimer());
  eyeButton.addEventListener('pointerleave', () => resetHideTimer());

  globalThis.addEventListener('scroll', hideEye, { passive: true });
  attachEyeButton();
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
  globalThis.removeEventListener('scroll', hideEye);
  clearHideTimer();
  clearShowTimer();

  if (eyeButton) {
    eyeButton.remove();
    eyeButton = null;
  }

  currentElement = null;
  toggleCallback = null;
  pendingAttachOnReady = false;
}
