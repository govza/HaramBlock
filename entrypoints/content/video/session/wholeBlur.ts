import { BLUR_CLASS } from '@/entrypoints/content/presentation/constants';
import { buildMaskingFilter } from '@/utils/masking';

import type { IHostSettings } from '@/utils/types';

/** Keyed on the saved-filter data attribute, not the class: YouTube rewrites `className`. */
export function isWholeBlurred(video: HTMLVideoElement): boolean {
  return video.dataset.hbOriginalFilter !== undefined;
}

export function applyWholeBlur(video: HTMLVideoElement, hostSettings: IHostSettings): void {
  if (!isWholeBlurred(video)) video.dataset.hbOriginalFilter = video.style.filter;
  video.classList.add(BLUR_CLASS);
  video.style.setProperty('filter', buildMaskingFilter(hostSettings.masking), 'important');
}

export function clearWholeBlur(video: HTMLVideoElement): void {
  video.classList.remove(BLUR_CLASS);
  if (!isWholeBlurred(video)) return;
  const original = video.dataset.hbOriginalFilter;
  delete video.dataset.hbOriginalFilter;
  if (original) {
    video.style.setProperty('filter', original);
  } else {
    video.style.removeProperty('filter');
  }
}
