import { createBlurBoxOverlays } from '@/entrypoints/content/presentation/boundingBox';
import { createMaskOverlays } from '@/entrypoints/content/presentation/maskOverlays';
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
    if (imagePrediction && hostSettings.masks.includes('blur')) {
      const overlayPromise = new Promise<void>(resolve => {
        requestAnimationFrame(() => {
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
