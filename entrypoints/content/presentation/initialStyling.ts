import type { IHostSettings } from '@/utils/types';

export const removeInitialImageStyling = (image: HTMLImageElement): void => {
  const classesToRemove = Array.from(image.classList).filter(className => className.startsWith('haramblock'));
  classesToRemove.forEach(className => image.classList.remove(className));
};

export const removeInitialVideoStyling = (video: HTMLVideoElement): void => {
  const classesToRemove = Array.from(video.classList).filter(className => className.startsWith('haramblock'));
  classesToRemove.forEach(className => video.classList.remove(className));
};

export const applyInitialVideoStyling = (video: HTMLVideoElement, hostSettings: IHostSettings): void => {
  if (hostSettings.policy === 'blacklist') {
    video.classList.add('haramblock-blacklist');
  } else if (hostSettings.policy === 'process') {
    video.classList.add('haramblock-initial-blur');
  }
};

export const applyInitialImageStyling = (image: HTMLImageElement, hostSettings: IHostSettings): void => {
  if (hostSettings.policy === 'blacklist') {
    image.classList.add('haramblock-blacklist');
  } else if (hostSettings.policy === 'process') {
    image.classList.add('haramblock-initial-blur');
  }
};
