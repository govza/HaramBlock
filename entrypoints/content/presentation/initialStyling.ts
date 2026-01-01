import type { IHostSettings } from '@/utils/types';

const removeBlacklistInlineStyles = (element: HTMLImageElement | HTMLVideoElement): void => {
  // Restore original styles if we saved them
  const originalFilter = element.dataset.haramblockOriginalFilter;
  const originalOpacity = element.dataset.haramblockOriginalOpacity;

  if (originalFilter !== undefined) {
    if (originalFilter) {
      element.style.filter = originalFilter;
    } else {
      element.style.removeProperty('filter');
    }
    delete element.dataset.haramblockOriginalFilter;
  }

  if (originalOpacity !== undefined) {
    if (originalOpacity) {
      element.style.opacity = originalOpacity;
    } else {
      element.style.removeProperty('opacity');
    }
    delete element.dataset.haramblockOriginalOpacity;
  }
};

export const removeInitialImageStyling = (image: HTMLImageElement): void => {
  const classesToRemove = Array.from(image.classList).filter(className => className.startsWith('haramblock'));
  classesToRemove.forEach(className => image.classList.remove(className));
  removeBlacklistInlineStyles(image);
};

export const removeInitialVideoStyling = (video: HTMLVideoElement): void => {
  const classesToRemove = Array.from(video.classList).filter(className => className.startsWith('haramblock'));
  classesToRemove.forEach(className => video.classList.remove(className));
  removeBlacklistInlineStyles(video);
};

const applyBlacklistStyling = (element: HTMLImageElement | HTMLVideoElement, hostSettings: IHostSettings): void => {
  const { masking } = hostSettings;

  // Save original styles before modifying
  element.dataset.haramblockOriginalFilter = element.style.filter || '';
  element.dataset.haramblockOriginalOpacity = element.style.opacity || '';

  // Build filter string based on masking settings
  const filters: string[] = [];

  // Blur intensity: 1-100% maps to 1-30px
  const blurPx = Math.round(masking.blurIntensity * 0.3);
  filters.push(`blur(${blurPx}px)`);

  if (masking.grayscale) {
    filters.push('grayscale(100%)');
  }

  if (masking.dark) {
    filters.push('brightness(0.4)');
  }

  element.style.setProperty('filter', filters.join(' '), 'important');
  element.style.setProperty('opacity', '0.3', 'important');
  element.classList.add('haramblock-blacklist');
};

export const applyInitialVideoStyling = (video: HTMLVideoElement, hostSettings: IHostSettings): void => {
  if (hostSettings.policy === 'blacklist') {
    applyBlacklistStyling(video, hostSettings);
  } else if (hostSettings.policy === 'process') {
    video.classList.add('haramblock-initial-blur');
  }
};

export const applyInitialImageStyling = (image: HTMLImageElement, hostSettings: IHostSettings): void => {
  if (hostSettings.policy === 'blacklist') {
    applyBlacklistStyling(image, hostSettings);
  } else if (hostSettings.policy === 'process') {
    image.classList.add('haramblock-initial-blur');
  }
};
