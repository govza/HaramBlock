import { createBlurBoxOverlays } from '@/entrypoints/content/presentation/boundingBox';
import { imageMaskOverlay } from '@/entrypoints/content/presentation/imageMaskOverlay';
import { logger, extractUrlId } from '@/utils/logger';
import { type IHostSettings, type IImagePrediction } from '@/utils/types';

export const applyPredictionsStyling = (
  images: HTMLImageElement[],
  predictions: IImagePrediction[],
  hostSettings: IHostSettings,
): Promise<void> => {
  const promises: Promise<void>[] = [];

  const predictionMap = new Map(predictions.map(p => [p.src, p]));

  for (const image of images) {
    const imageSrc = image.currentSrc || image.src;
    const imagePrediction = predictionMap.get(imageSrc);

    logger.withTag('predictionStyling').debug('Processing image', {
      imageSrc: extractUrlId(imageSrc),
      hasImagePrediction: Boolean(imagePrediction),
      masking: hostSettings.masking,
      outline: hostSettings.outline,
      policy: hostSettings.policy,
    });

    if (imagePrediction && hostSettings.masking.blur) {
      const overlayPromise = new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          logger.withTag('predictionStyling').debug('Creating overlay', {
            outline: hostSettings.outline,
            imageSrc: extractUrlId(imageSrc),
          });

          if (hostSettings.outline === 'bbox') {
            createBlurBoxOverlays(image, imagePrediction, hostSettings);
          } else if (hostSettings.outline === 'segment') {
            imageMaskOverlay.createMaskOverlay(image, imagePrediction, hostSettings);
          }
          resolve();
        });
      });
      promises.push(overlayPromise);
    }
  }

  return Promise.all(promises).then(() => {});
};
