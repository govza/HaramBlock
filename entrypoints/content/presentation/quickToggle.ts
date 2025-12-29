import type { IImagePrediction } from '@/utils/types';

// Eye open SVG path (visible/unmasked state)
const EYE_OPEN_PATH =
  'M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z';

// Eye with slash SVG path (hidden/masked state)
const EYE_CLOSED_PATH =
  'M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.08L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.74,7.13 11.35,7 12,7Z';

const HIDE_DELAY_MS = 2500;

type ToggleCallback = (src: string, isUnmasked: boolean) => void;
type RegisteredElement = {
  element: HTMLImageElement | HTMLVideoElement;
  prediction: IImagePrediction;
};

let eyeButton: HTMLButtonElement | null = null;
let currentElement: (HTMLImageElement | HTMLVideoElement) | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let toggleCallback: ToggleCallback | null = null;

const registeredElements = new WeakMap<HTMLImageElement | HTMLVideoElement, RegisteredElement>();

function createSvgIcon(isUnmasked: boolean): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'white');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', isUnmasked ? EYE_OPEN_PATH : EYE_CLOSED_PATH);
  svg.appendChild(path);

  return svg;
}

function updateButtonIcon(isUnmasked: boolean): void {
  if (!eyeButton) return;
  eyeButton.innerHTML = '';
  eyeButton.appendChild(createSvgIcon(isUnmasked));
}

function positionEye(element: HTMLElement): void {
  if (!eyeButton) return;

  const rect = element.getBoundingClientRect();
  const { clientWidth: viewportWidth } = document.documentElement;

  // Position at top-right of element
  const top = rect.top < 0 ? 0 : rect.top;
  let { left } = rect;
  left = rect.right - 32; // Button width is 2rem ≈ 32px
  if (left + 32 > viewportWidth) left = viewportWidth - 32;
  if (left < rect.left) ({ left } = rect);

  eyeButton.style.top = `${top + 8}px`;
  eyeButton.style.left = `${left - 8}px`;
}

function showEye(element: HTMLImageElement | HTMLVideoElement): void {
  if (!eyeButton) return;

  const registered = registeredElements.get(element);
  if (!registered) return;

  currentElement = element;
  updateButtonIcon(registered.prediction.isUnmasked);
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

  registered.prediction.isUnmasked = !registered.prediction.isUnmasked;
  updateButtonIcon(registered.prediction.isUnmasked);
  resetHideTimer();

  if (toggleCallback) {
    toggleCallback(registered.prediction.src, registered.prediction.isUnmasked);
  }
}

function handleMouseEnter(e: Event): void {
  const target = e.currentTarget as HTMLImageElement | HTMLVideoElement;
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
  eyeButton.appendChild(createSvgIcon(false));

  eyeButton.addEventListener('click', handleClick);
  eyeButton.addEventListener('mouseenter', () => clearHideTimer());
  eyeButton.addEventListener('mouseleave', () => resetHideTimer());

  globalThis.addEventListener('scroll', hideEye, { passive: true });

  document.body.appendChild(eyeButton);
}

export function initQuickToggle(onToggle: ToggleCallback): void {
  toggleCallback = onToggle;
  createGlobalEyeButton();
}

export function registerQuickToggle(
  element: HTMLImageElement | HTMLVideoElement,
  prediction: IImagePrediction,
  quickToggle: { unsafeEnabled: boolean; safeEnabled: boolean },
): void {
  const hasPredictions = Boolean(prediction.predictions?.length);
  const shouldRegister = hasPredictions ? quickToggle.unsafeEnabled : quickToggle.safeEnabled;
  if (!shouldRegister) return;

  registeredElements.set(element, { element, prediction });

  element.addEventListener('mouseenter', handleMouseEnter);
  element.addEventListener('mouseleave', handleMouseLeave);
}

export function unregisterQuickToggle(element: HTMLImageElement | HTMLVideoElement): void {
  registeredElements.delete(element);
  element.removeEventListener('mouseenter', handleMouseEnter);
  element.removeEventListener('mouseleave', handleMouseLeave);

  if (currentElement === element) {
    hideEye();
  }
}

export function updateQuickTogglePrediction(
  element: HTMLImageElement | HTMLVideoElement,
  prediction: IImagePrediction,
): void {
  const registered = registeredElements.get(element);
  if (registered) {
    registered.prediction = prediction;
    if (currentElement === element) {
      updateButtonIcon(prediction.isUnmasked);
    }
  }
}

export function isElementRegistered(element: HTMLImageElement | HTMLVideoElement): boolean {
  return registeredElements.has(element);
}
