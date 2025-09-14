import { requestImageInference } from '@/entrypoints/content/communication/sender';
import {
  isHandled,
  markHandled,
  markSentForInference,
  isSentForInference,
  markProcessed,
} from '@/entrypoints/content/handlers/status';
import { clearBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { applyInitialImageStyling, removeInitialImageStyling } from '@/entrypoints/content/presentation/initialStyling';
import { clearMaskOverlay } from '@/entrypoints/content/presentation/maskOverlays';
import { defaultHostSettings } from '@/utils/db/constants';
import { extractUrlId, logger } from '@/utils/logger';

import type { IHostSettings } from '@/utils/types';

export function handleImages(images: HTMLImageElement[], hostSettings: IHostSettings): void {
  for (const image of images) {
    const src = image.currentSrc || image.src;
    if (!src) continue;
    if (!isHandled(image, src)) {
      applyInitialImageStyling(image, hostSettings);
      markHandled(image, src);
      queueForInference(image, hostSettings);
    }
  }
}

export function handleImageAttributeChange(img: HTMLImageElement, hostSettings: IHostSettings): void {
  const currentSrc = img.currentSrc || img.src;
  if (img.dataset.hbSrc && img.dataset.hbSrc !== currentSrc) {
    clearMaskOverlay(img);
    clearBlurBoxOverlay(img);
    removeInitialImageStyling(img);
    delete img.dataset.hbHandled;
    delete img.dataset.hbSent;
    delete img.dataset.hbProcessed;
    img.dataset.hbSrc = currentSrc;
  }
  handleImages([img], hostSettings);
}

function queueForInference(image: HTMLImageElement, hostSettings: IHostSettings): void {
  const trySendForInference = async () => {
    const src = image.currentSrc || image.src;
    if (!src) return;

    if (isSentForInference(image, src)) {
      return;
    }

    const minW = hostSettings.minSize?.width ?? defaultHostSettings.minSize.width;
    const minH = hostSettings.minSize?.height ?? defaultHostSettings.minSize.height;
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (w < minW || h < minH) {
      markProcessed(image, src);
      return;
    }

    try {
      await requestImageInference(hostSettings.hostname, image);
      markSentForInference(image, src);
      logger.withTag('pipeline').debug(`Sent image ${extractUrlId(src)} for inference`);
    } catch (error) {
      logger.withTag('pipeline').error(`Failed to send image ${extractUrlId(src)} for inference:`, error);
      markProcessed(image, src);
    }
  };

  if (image.complete && image.naturalWidth > 0) {
    void trySendForInference();
    return;
  }

  const onLoad = () => {
    void trySendForInference();
  };
  image.addEventListener('load', onLoad, { once: true });
}
