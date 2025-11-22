import { clearBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { imageMaskOverlay } from '@/entrypoints/content/presentation/imageMaskOverlay';
import { removeInitialImageStyling } from '@/entrypoints/content/presentation/initialStyling';

export const handleMediaRemoved = (elements: HTMLElement[]): void => {
  for (const el of elements) {
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') {
      cleanupMediaElement(el as HTMLImageElement | HTMLVideoElement);
    }
  }
};

const cleanupMediaElement = (el: HTMLImageElement | HTMLVideoElement): void => {
  if (el.tagName === 'IMG') {
    const img = el as HTMLImageElement;
    imageMaskOverlay.clearMaskOverlay(img);
    clearBlurBoxOverlay(img);
    removeInitialImageStyling(img);
  }
  delete el.dataset.hbSrc;
  delete el.dataset.hbHandled;
  delete el.dataset.hbSent;
  delete el.dataset.hbProcessed;
};
