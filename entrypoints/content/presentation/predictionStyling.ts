import { createBlurBoxOverlays } from '@/entrypoints/content/presentation/boundingBox';
import { createMaskOverlays } from '@/entrypoints/content/presentation/maskOverlays';
import { logger, extractUrlId } from '@/utils/logger';
import { type IHostSettings, type IImagePrediction } from '@/utils/types';

export const applyPredictionsStyling = (
  images: HTMLImageElement[],
  predictions: IImagePrediction[],
  hostSettings: IHostSettings,
): Promise<void> => {
  const predictionMap = new Map<string, IImagePrediction>();
  predictions.forEach(prediction => {
    predictionMap.set(prediction.src, prediction);
  });

  const promises: Promise<void>[] = [];

  for (const image of images) {
    const imageSrc = image.currentSrc || image.src;
    const imagePrediction = predictionMap.get(imageSrc);

    logger.withTag('predictionStyling').debug('Processing image', {
      imageSrc: extractUrlId(imageSrc),
      hasImagePrediction: Boolean(imagePrediction),
      maskSettings: hostSettings.masks,
      includesBlur: hostSettings.masks.includes('blur'),
      outline: hostSettings.outline,
      policy: hostSettings.policy,
    });

    if (imagePrediction && hostSettings.masks.includes('blur')) {
      const overlayPromise = new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          logger.withTag('predictionStyling').debug('Creating overlay', {
            outline: hostSettings.outline,
            imageSrc: extractUrlId(imageSrc),
          });

          if (hostSettings.outline === 'bbox') {
            createBlurBoxOverlays(image, imagePrediction);
          } else if (hostSettings.outline === 'segment') {
            createMaskOverlays(image, imagePrediction);
          }
          resolve();
        });
      });
      promises.push(overlayPromise);
    }
  }

  return Promise.all(promises).then(() => {});
};
