import { imageMaskOverlay } from '@/entrypoints/content/presentation/imageMaskOverlay';
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

    if (imagePrediction) {
      const overlayPromise = new Promise<void>(resolve => {
        let attempts = 0;
        const tryCreate = () => {
          // A re-render can detach the image before this frame; creating
          // against it bails silently with no retry, leaving the unsafe image
          // unmasked. Wait briefly for re-attachment.
          if (!image.isConnected && attempts < 30) {
            attempts += 1;
            requestAnimationFrame(tryCreate);
            return;
          }
          imageMaskOverlay.createMaskOverlay(image, imagePrediction, hostSettings);
          resolve();
        };
        requestAnimationFrame(tryCreate);
      });
      promises.push(overlayPromise);
    }
  }

  return Promise.all(promises).then(() => {});
};
