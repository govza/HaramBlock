import { PredictionCache, IImagePrediction } from '@/utils/db/predictionCache';

/**
 * PredictionCacheService handles business logic for prediction cache
 * Coordinates between controllers and data layer for cached predictions
 */
export class PredictionCacheService {
  /**
   * Cache predictions ensuring uniqueness by src URL
   * @param predictions - Array of predictions to cache
   * @param hostname - Hostname for caching
   */
  async cachePredictions(predictions: IImagePrediction[], hostname: string): Promise<void> {
    console.log(`Caching ${predictions.length} predictions for hostname: ${hostname}`);
    
    try {
      const cachePromises = predictions.map(async (prediction) => {
        // Create prediction cache instance and save (upsert)
        // The database schema ensures src uniqueness, so put() will overwrite existing entries
        const predictionCache = new PredictionCache(prediction);
        return await predictionCache.save();
      });
      
      await Promise.all(cachePromises);
      console.log(`Successfully cached all predictions`);
    } catch (error) {
      console.error('Error caching predictions:', error);
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
      const predictions = await PredictionCache.findValidByHostname(hostname);
      
      // Serialize the data to return immediately
      const serializedPredictions = predictions.map(prediction => prediction.serialize());
      
      // Update access time and save in background (fire-and-forget)
      if (predictions.length > 0) {
        Promise.all(
          predictions.map(async (prediction) => {
            try {
              prediction.updateAccessTime();
              await prediction.save();
            } catch (error) {
              console.warn('Failed to update access time for prediction:', prediction.src, error);
            }
          })
        ).catch(error => {
          console.warn('Background access time update failed:', error);
        });
      }
      
      return serializedPredictions;
    } catch (error) {
      console.error('Error retrieving cached predictions for hostname:', hostname, error);
      throw error;
    }
  }
}