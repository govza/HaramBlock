import { EYE_AUTO_PATH, EYE_BLOCKED_PATH, EYE_VISIBLE_PATH } from '@/components/ui/icons';

import type { IImagePrediction } from '@/utils/types';

type ForcedVisibility = IImagePrediction['forcedVisibility'];

const HIDE_DELAY_MS = 2500;

type ToggleCallback = (src: string, forcedVisibility: ForcedVisibility) => void;
type RegisteredElement = {
  prediction: IImagePrediction;
};

let eyeButton: HTMLButtonElement | null = null;
let currentElement: HTMLImageElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let toggleCallback: ToggleCallback | null = null;

const registeredElements = new WeakMap<HTMLImageElement, RegisteredElement>();

function getNextState(current: ForcedVisibility): ForcedVisibility {
  // Both unsafe and safe: null → blocked → visible → null
  if (current === null) return 'blocked';
  if (current === 'blocked') return 'visible';
  return null;
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
  if (!eyeButton) return;

  const registered = registeredElements.get(element);
  if (!registered) return;

  currentElement = element;
  updateButtonIcon(registered.prediction);
  positionEye(element);
  eyeButton.style.display = 'flex';

  resetHideTimer();
}

function hideEye(): void {
  if (!eyeButton) return;
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

function handleClick(e: Event): void {
  e.preventDefault();
  e.stopPropagation();

  if (!currentElement) return;
  const registered = registeredElements.get(currentElement);
  if (!registered) return;

  const nextForcedVisibility = getNextState(registered.prediction.forcedVisibility);

  if (toggleCallback) {
    toggleCallback(registered.prediction.src, nextForcedVisibility);
  }

  registered.prediction.forcedVisibility = nextForcedVisibility;
  updateButtonIcon(registered.prediction);
  resetHideTimer();
}

function handleMouseEnter(e: Event): void {
  const target = e.currentTarget as HTMLImageElement;
  if (registeredElements.has(target)) {
    showEye(target);
  }
}

function handleMouseLeave(): void {
  resetHideTimer();
}

function createGlobalEyeButton(): void {
  if (eyeButton) return;

  eyeButton = document.createElement('button');
  eyeButton.className = 'haramblock-eye-toggle';
  eyeButton.style.position = 'fixed';
  eyeButton.style.display = 'none';
  eyeButton.appendChild(createSvgIcon('blocked'));

  eyeButton.addEventListener('click', handleClick);
  eyeButton.addEventListener('mouseenter', () => clearHideTimer());
  eyeButton.addEventListener('mouseleave', () => resetHideTimer());

  globalThis.addEventListener('scroll', hideEye, { passive: true });

  if (!document.body) {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        if (eyeButton && !eyeButton.isConnected) {
          document.body.appendChild(eyeButton);
        }
      },
      { once: true },
    );
    return;
  }

  document.body.appendChild(eyeButton);
}

export function initQuickToggle(onToggle: ToggleCallback): void {
  toggleCallback = onToggle;
  createGlobalEyeButton();
}

export function registerQuickToggle(
  element: HTMLImageElement,
  prediction: IImagePrediction,
  quickToggle: { unsafeEnabled: boolean; safeEnabled: boolean },
): void {
  const hasPredictions = Boolean(prediction.predictions?.length);
  const shouldRegister = hasPredictions ? quickToggle.unsafeEnabled : quickToggle.safeEnabled;
  if (!shouldRegister) return;

  const existing = registeredElements.get(element);
  if (existing) {
    existing.prediction = prediction;
    return;
  }

  registeredElements.set(element, { prediction });

  element.addEventListener('mouseenter', handleMouseEnter);
  element.addEventListener('mouseleave', handleMouseLeave);
}

export function unregisterQuickToggle(element: HTMLImageElement): void {
  registeredElements.delete(element);
  element.removeEventListener('mouseenter', handleMouseEnter);
  element.removeEventListener('mouseleave', handleMouseLeave);

  if (currentElement === element) {
    hideEye();
  }
}

export function updateQuickTogglePrediction(element: HTMLImageElement, prediction: IImagePrediction): void {
  const registered = registeredElements.get(element);
  if (registered) {
    registered.prediction = prediction;
    if (currentElement === element) {
      updateButtonIcon(prediction);
    }
  }
}

export function isElementRegistered(element: HTMLImageElement): boolean {
  return registeredElements.has(element);
}

export function destroyQuickToggle(): void {
  globalThis.removeEventListener('scroll', hideEye);
  clearHideTimer();

  if (eyeButton) {
    eyeButton.remove();
    eyeButton = null;
  }

  currentElement = null;
  toggleCallback = null;
}
