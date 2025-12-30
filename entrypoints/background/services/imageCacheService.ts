import { ImageCacheRepository } from '@/utils/db/imageCacheRepository';
import { logger } from '@/utils/logger';
import { type IImagePrediction } from '@/utils/types';

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
  async updateToggleState(src: string, forcedVisibility: 'visible' | 'blocked' | null): Promise<void> {
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
