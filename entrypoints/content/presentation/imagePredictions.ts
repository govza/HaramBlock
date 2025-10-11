import { markHandled, markProcessed } from '@/entrypoints/content/core/status';
import { clearBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { removeInitialImageStyling } from '@/entrypoints/content/presentation/initialStyling';
import { clearMaskOverlay } from '@/entrypoints/content/presentation/maskOverlays';
import { applyPredictionsStyling } from '@/entrypoints/content/presentation/predictionStyling';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

export async function applyImagePredictionsToDom(
  preds: IImagePrediction[],
  hostSettings: IHostSettings,
  targetImages?: HTMLImageElement[],
): Promise<void> {
  // Deduplicate by src to avoid re-applying overlays multiple times per batch
  const bySrc = new Map<string, IImagePrediction>();
  for (const p of preds) bySrc.set(p.src, p);
  const uniquePreds = Array.from(bySrc.values());

  const processPrediction = async (pred: IImagePrediction): Promise<void> => {
    // Use target images if provided, otherwise find by data attributes
    const images = targetImages
      ? targetImages.filter(img => (img.currentSrc || img.src) === pred.src)
      : findImagesByDataSrc(pred.src);
    if (!images.length) return;

    // Wait for images to load before applying styling
    const loadedImages = await Promise.all(
      images.map(async img => {
        if (img.complete && img.naturalWidth > 0) {
          return img;
        }

        return new Promise<HTMLImageElement>(resolve => {
          const handleLoad = () => {
            img.removeEventListener('load', handleLoad);
            img.removeEventListener('error', handleError);
            resolve(img);
          };

          const handleError = () => {
            img.removeEventListener('load', handleLoad);
            img.removeEventListener('error', handleError);
            resolve(img); // Still resolve to allow cleanup
          };

          img.addEventListener('load', handleLoad);
          img.addEventListener('error', handleError);
        });
      }),
    );

    // If this prediction has no detections, ensure overlays are cleared
    if (!pred.predictions || pred.predictions.length === 0) {
      for (const image of loadedImages) {
        clearMaskOverlay(image);
        clearBlurBoxOverlay(image);
        removeInitialImageStyling(image);
        markHandled(image, pred.src);
        markProcessed(image, pred.src);
      }
      return;
    }

    // Only apply styling to fully loaded images
    const fullyLoadedImages = loadedImages.filter(img => img.complete && img.naturalWidth > 0);
    if (fullyLoadedImages.length > 0) {
      await applyPredictionsStyling(fullyLoadedImages, [pred], hostSettings);
    }

    for (const image of loadedImages) {
      markProcessed(image, pred.src);
      removeInitialImageStyling(image);
    }
  };

  await Promise.all(uniquePreds.map(processPrediction));
}

function findImagesByDataSrc(src: string): HTMLImageElement[] {
  // Use CSS selector to find images with matching data-hb-src attribute
  const selector = `img[data-hb-src="${CSS.escape(src)}"]`;
  return Array.from(document.querySelectorAll<HTMLImageElement>(selector));
}
