import { PredictionCacheRepository } from '@/utils/db/predictionCacheRepository';
import { logger } from '@/utils/logger';
import { type IImagePrediction } from '@/utils/types';

/**
 * PredictionCacheService handles business logic for prediction cache
 * Coordinates between controllers and data layer for cached predictions
 */
export class PredictionCacheService {
  private repository: PredictionCacheRepository;

  constructor() {
    this.repository = new PredictionCacheRepository();
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
      logger.withTag('predictionCacheService').error('Error caching predictions:', error);
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
                .withTag('predictionCacheService')
                .warn('Failed to update access time for prediction:', prediction.src, error);
            }
          }),
        ).catch(error => {
          logger.withTag('predictionCacheService').warn('Background access time update failed:', error);
        });
      }

      return predictionsToReturn;
    } catch (error) {
      logger
        .withTag('predictionCacheService')
        .error('Error retrieving cached predictions for hostname:', hostname, error);
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
      logger.withTag('predictionCacheService').error('Error retrieving cached prediction by src:', src, error);
      throw error;
    }
  }
}
