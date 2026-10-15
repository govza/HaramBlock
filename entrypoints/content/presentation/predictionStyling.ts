import { resolveImageSource } from '@/entrypoints/content/core/imageSource';
import { imageMaskOverlay } from '@/entrypoints/content/presentation/imageMaskOverlay';
import { type IHostSettings, type IImagePrediction } from '@/utils/types';

export const applyPredictionsStyling = (
  images: HTMLImageElement[],
  predictions: IImagePrediction[],
  hostSettings: IHostSettings,
): Promise<void> => {
  const predictionMap = new Map(predictions.map(p => [p.src, p]));
  const masked = images.flatMap(image => {
    const prediction = predictionMap.get(resolveImageSource(image));
    return prediction ? [{ image, prediction }] : [];
  });
  if (!masked.length) return Promise.resolve();

  return new Promise<void>(resolve => {
    requestAnimationFrame(() => {
      for (const { image, prediction } of masked) {
        imageMaskOverlay.createMaskOverlay(image, prediction, hostSettings);
      }
      resolve();
    });
  });
};
