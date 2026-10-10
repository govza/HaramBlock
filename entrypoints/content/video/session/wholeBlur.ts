import { BLUR_CLASS } from '@/entrypoints/content/presentation/constants';
import { buildMaskingFilter } from '@/utils/masking';

import type { IHostSettings } from '@/utils/types';

export function applyWholeBlur(video: HTMLVideoElement, hostSettings: IHostSettings): void {
  if (!video.classList.contains(BLUR_CLASS) && video.style.filter) {
    video.dataset.hbOriginalFilter = video.style.filter;
  }
  video.classList.add(BLUR_CLASS);
  video.style.setProperty('filter', buildMaskingFilter(hostSettings.masking), 'important');
}

export function clearWholeBlur(video: HTMLVideoElement): void {
  video.classList.remove(BLUR_CLASS);
  const original = video.dataset.hbOriginalFilter;
  delete video.dataset.hbOriginalFilter;
  if (original) {
    video.style.setProperty('filter', original);
  } else {
    video.style.removeProperty('filter');
  }
}
