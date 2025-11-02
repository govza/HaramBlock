import { disposeVideoSession } from '@/entrypoints/content/handlers/handleVideos';
import { clearBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { removeInitialImageStyling } from '@/entrypoints/content/presentation/initialStyling';
import { clearMaskOverlay } from '@/entrypoints/content/presentation/maskOverlays';

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
    clearMaskOverlay(img);
    clearBlurBoxOverlay(img);
    removeInitialImageStyling(img);
  } else if (el.tagName === 'VIDEO') {
    disposeVideoSession(el as HTMLVideoElement);
  }
  delete el.dataset.hbSrc;
  delete el.dataset.hbHandled;
  delete el.dataset.hbSent;
  delete el.dataset.hbProcessed;
};
