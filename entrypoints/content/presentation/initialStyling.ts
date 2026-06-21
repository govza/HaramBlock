import {
  BLACKLIST_ATTR,
  BLUR_CLASS,
  PROCESSED_SAFE_ATTR,
  PROCESSED_SKIPPED_ATTR,
  PROCESSED_UNSAFE_ATTR,
} from '@/entrypoints/content/presentation/constants';
import { buildMaskingFilter } from '@/utils/masking';

import type { IHostSettings } from '@/utils/types';

export type ProcessedStatus = 'safe' | 'unsafe' | 'skipped';

const PROCESSED_ATTRS = [PROCESSED_SAFE_ATTR, PROCESSED_SKIPPED_ATTR, PROCESSED_UNSAFE_ATTR];

const PROCESSED_ATTR_MAP = {
  safe: PROCESSED_SAFE_ATTR,
  unsafe: PROCESSED_UNSAFE_ATTR,
  skipped: PROCESSED_SKIPPED_ATTR,
} as const;

/** Clear all processed status attributes from element */
const clearProcessedStatus = (element: HTMLImageElement | HTMLVideoElement): void => {
  for (const attr of PROCESSED_ATTRS) {
    element.removeAttribute(attr);
  }
};

/** Check if element has any initial styling applied (blur class or blacklist) */
export const hasInitialStyling = (element: HTMLImageElement | HTMLVideoElement): boolean => {
  return element.classList.contains(BLUR_CLASS) || element.hasAttribute(BLACKLIST_ATTR);
};

/** Check if element has blacklist styling applied */
export const hasBlacklistStyling = (element: HTMLImageElement | HTMLVideoElement): boolean => {
  return element.hasAttribute(BLACKLIST_ATTR);
};

const removeBlacklistInlineStyles = (element: HTMLImageElement | HTMLVideoElement): void => {
  const originalFilter = element.dataset.haramblockOriginalFilter;

  if (originalFilter !== undefined) {
    if (originalFilter) {
      element.style.filter = originalFilter;
    } else {
      element.style.removeProperty('filter');
    }
    delete element.dataset.haramblockOriginalFilter;
  }

  element.removeAttribute(BLACKLIST_ATTR);
};

/** Reset image styling - clears all haramblock classes, blacklist styles, and processed status */
export const resetImageStyling = (image: HTMLImageElement): void => {
  const classesToRemove = Array.from(image.classList).filter(className => className.startsWith('haramblock'));
  classesToRemove.forEach(className => image.classList.remove(className));
  removeBlacklistInlineStyles(image);
  clearProcessedStatus(image);
};

/** Reset video styling - clears all haramblock classes, blacklist styles, and processed status */
export const resetVideoStyling = (video: HTMLVideoElement): void => {
  const classesToRemove = Array.from(video.classList).filter(className => className.startsWith('haramblock'));
  classesToRemove.forEach(className => video.classList.remove(className));
  removeBlacklistInlineStyles(video);
  clearProcessedStatus(video);
};

/** Finalize image processing - clears styling and sets the final processed status */
export const finalizeImageProcessing = (image: HTMLImageElement, status: ProcessedStatus): void => {
  resetImageStyling(image);
  image.setAttribute(PROCESSED_ATTR_MAP[status], '');
};

/** Finalize video processing - clears styling and sets the final processed status */
export const finalizeVideoProcessing = (video: HTMLVideoElement, status: ProcessedStatus): void => {
  resetVideoStyling(video);
  video.setAttribute(PROCESSED_ATTR_MAP[status], '');
};

export const applyBlacklistStyling = (
  element: HTMLImageElement | HTMLVideoElement,
  hostSettings: IHostSettings,
): void => {
  element.dataset.haramblockOriginalFilter = element.style.filter || '';
  element.style.setProperty('filter', buildMaskingFilter(hostSettings.masking), 'important');
  element.setAttribute(BLACKLIST_ATTR, '');
};

export const applyInitialVideoStyling = (video: HTMLVideoElement, hostSettings: IHostSettings): void => {
  if (hostSettings.policy.behavior === 'blacklist') {
    applyBlacklistStyling(video, hostSettings);
  } else if (hostSettings.policy.behavior === 'process') {
    video.classList.add('haramblock-initial-blur');
  }
};

export const applyInitialImageStyling = (image: HTMLImageElement, hostSettings: IHostSettings): void => {
  if (hostSettings.policy.behavior === 'blacklist') {
    applyBlacklistStyling(image, hostSettings);
  } else if (hostSettings.policy.behavior === 'process') {
    image.classList.add('haramblock-initial-blur');
  }
};
