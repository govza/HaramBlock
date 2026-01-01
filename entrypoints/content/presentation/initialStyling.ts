import { buildMaskingFilter } from '@/utils/masking';

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
  // Save original styles before modifying
  element.dataset.haramblockOriginalFilter = element.style.filter || '';
  element.dataset.haramblockOriginalOpacity = element.style.opacity || '';

  element.style.setProperty('filter', buildMaskingFilter(hostSettings.masking), 'important');
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
