import type { IHostSettings } from '@/utils/types';

export const removeInitialImageStyling = (image: HTMLImageElement): void => {
  const classesToRemove = Array.from(image.classList).filter(className => className.startsWith('haramblock'));
  classesToRemove.forEach(className => image.classList.remove(className));
};

export const applyInitialImageStyling = (image: HTMLImageElement, hostSettings: IHostSettings): void => {
  if (hostSettings.policy === 'blacklist') {
    image.classList.add('haramblock-blacklist');
  } else if (hostSettings.masking.blur) {
    image.classList.add('haramblock-initial-blur');
  }
};
