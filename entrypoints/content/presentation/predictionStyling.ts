import { createBlurBoxOverlays } from '@/entrypoints/content/presentation/boundingBox';
import { imageMaskOverlay } from '@/entrypoints/content/presentation/imageMaskOverlay';
import { videoMaskOverlays } from '@/entrypoints/content/presentation/videoMaskOverlay';
import { logger, extractUrlId } from '@/utils/logger';
import { type IHostSettings, type IImagePrediction } from '@/utils/types';

export const applyPredictionsStyling = (
  mediaElements: (HTMLImageElement | HTMLVideoElement)[],
  predictions: IImagePrediction[],
  hostSettings: IHostSettings,
): Promise<void> => {
  const promises: Promise<void>[] = [];

  const predictionMap = new Map(predictions.map(p => [p.src, p]));

  for (const element of mediaElements) {
    const elementSrc = element.currentSrc || element.src;
    const prediction = predictionMap.get(elementSrc);

    logger.withTag('predictionStyling').debug('Processing media element', {
      elementType: element.tagName.toLowerCase(),
      elementSrc: extractUrlId(elementSrc),
      hasPrediction: Boolean(prediction),
      masking: hostSettings.masking,
      outline: hostSettings.outline,
      policy: hostSettings.policy,
    });

    if (prediction && hostSettings.masking.blur) {
      const overlayPromise = new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          if (hostSettings.outline === 'bbox') {
            // bbox system supports both images and videos
            createBlurBoxOverlays(element, prediction);
            resolve();
          } else if (hostSettings.outline === 'segment') {
            // segment system has separate implementations for images and videos
            if (element instanceof HTMLImageElement) {
              imageMaskOverlay.createMaskOverlay(element, prediction);
              resolve();
            } else if (element instanceof HTMLVideoElement) {
              void videoMaskOverlays.createMaskOverlay(element, prediction).then(() => resolve());
            } else {
              resolve();
            }
          } else {
            resolve();
          }
        });
      });
      promises.push(overlayPromise);
    }
  }

  return Promise.all(promises).then(() => {});
};
