import { ImageCacheRepository } from '@/utils/db/imageCacheRepository';
import { logger } from '@/utils/logger';
import { type ForcedVisibility, type IImagePrediction } from '@/utils/types';

// Letterbox crop rounding shifts the grid content box by up to ~1 cell; anything
// beyond this is real element/resource dimension skew (e.g. srcset density-corrected
// naturalWidth), which paints masks at the wrong scale.
const DIMS_TOLERANCE = 0.02;

/**
 * Warns when a prediction's stored dimensions disagree with its own maskTransform.
 * Invariant: (mask.width - 2*offsetX) * scaleX ≈ prediction.width (same for Y) — the
 * mask grid's content box scaled back to image space must land on the image dims.
 */
const warnIfInconsistent = (prediction: IImagePrediction): void => {
  if (!prediction.width || !prediction.height) return;
  const mask = prediction.predictions.find(p => p.masks && p.masks.width > 0)?.masks;
  if (!mask) return;

  const { scaleX, scaleY, offsetX, offsetY } = prediction.maskTransform;
  const expectedW = (mask.width - 2 * offsetX) * scaleX;
  const expectedH = (mask.height - 2 * offsetY) * scaleY;
  const skewX = Math.abs(expectedW - prediction.width) / prediction.width;
  const skewY = Math.abs(expectedH - prediction.height) / prediction.height;
  if (skewX <= DIMS_TOLERANCE && skewY <= DIMS_TOLERANCE) return;

  logger.withTag('imageCacheService').warn(
    `prediction self-consistency failed ${JSON.stringify({
      src: prediction.src.slice(-60),
      width: prediction.width,
      height: prediction.height,
      expectedW: Math.round(expectedW),
      expectedH: Math.round(expectedH),
      maskTransform: prediction.maskTransform,
      gridW: mask.width,
      gridH: mask.height,
    })}`,
  );
};

/**
 * ImageCacheService handles business logic for image prediction cache
 * Coordinates between controllers and data layer for cached image predictions
 */
export class ImageCacheService {
  private repository: ImageCacheRepository;

  constructor() {
    try {
      this.repository = new ImageCacheRepository();
    } catch {
      logger.withTag('imageCacheService').error('Failed to initialize ImageCacheRepository');
      throw new Error('Failed to initialize ImageCacheRepository');
    }
  }
  /**
   * Cache predictions ensuring uniqueness by src URL
   * @param predictions - Array of predictions to cache
   * @param hostname - Hostname for caching
   */
  async cachePredictions(predictions: IImagePrediction[]): Promise<void> {
    try {
      const cachePromises = predictions.map(async prediction => {
        warnIfInconsistent(prediction);
        // Save prediction directly (upsert)
        // The database schema ensures src uniqueness, so put() will overwrite existing entries
        return this.repository.savePrediction(prediction);
      });

      await Promise.all(cachePromises);
    } catch (error) {
      logger.withTag('imageCacheService').error('Error caching predictions:', error);
      throw error;
    }
  }

  /**
   * Retrieve cached predictions for a given hostname
   * @param hostname - The hostname to retrieve predictions for
   * @returns Promise resolving to array of cached predictions
   */
  async getCachedPredictionsByHostname(hostname: string): Promise<IImagePrediction[]> {
    if (!hostname || !hostname.trim()) {
      throw new Error('Hostname is required');
    }

    try {
      // Get only valid (non-expired) predictions
      const predictions = await this.repository.findValidByHostname(hostname);

      // Return the predictions directly (no need to serialize since they're already plain objects)
      const predictionsToReturn = [...predictions];

      // Update access time and save in background (fire-and-forget)
      if (predictions.length > 0) {
        Promise.all(
          predictions.map(async prediction => {
            try {
              const updatedPrediction = this.repository.updateAccessTime(prediction);
              await this.repository.savePrediction(updatedPrediction);
            } catch (error) {
              logger
                .withTag('imageCacheService')
                .warn('Failed to update access time for prediction:', prediction.src, error);
            }
          }),
        ).catch(error => {
          logger.withTag('imageCacheService').warn('Background access time update failed:', error);
        });
      }

      return predictionsToReturn;
    } catch (error) {
      logger.withTag('imageCacheService').error('Error retrieving cached predictions for hostname:', hostname, error);
      throw error;
    }
  }

  async getCachedPredictionsBySrc(src: string): Promise<IImagePrediction[]> {
    if (!src || !src.trim()) {
      throw new Error('Source URL is required');
    }

    try {
      // Find prediction by src URL
      const predictions = await this.repository.findBySrc(src);
      return predictions;
    } catch (error) {
      logger.withTag('imageCacheService').error('Error retrieving cached prediction by src:', src, error);
      throw error;
    }
  }

  // Updates first prediction only. Database uses src as primary key, so only one prediction per src exists.
  async updateToggleState(src: string, forcedVisibility: ForcedVisibility): Promise<void> {
    try {
      const predictions = await this.repository.findBySrc(src);
      const original = predictions[0];
      if (!original) return;

      const updatedPrediction: IImagePrediction = {
        ...original,
        forcedVisibility,
      };
      await this.repository.savePrediction(updatedPrediction);
    } catch (error) {
      logger.withTag('imageCacheService').error('Error updating toggle state:', src, error);
      throw error;
    }
  }
}
