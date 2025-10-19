import { type BridgeMessage } from 'webext-bridge';
import { onMessage } from 'webext-bridge/background';

import { type ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import { logger } from '@/utils/logger';
import { type IImagePrediction } from '@/utils/types';

export class ImageCacheController {
  private readonly imageCacheService: ImageCacheService;

  constructor(imageCacheService: ImageCacheService) {
    this.imageCacheService = imageCacheService;
  }

  /**
   * Initialize message listeners (API)
   */
  public initialize(): void {
    onMessage('GET_HOSTNAME_IMAGE_PREDICTION_CACHE', this.getHostnameImagePredictionCache.bind(this));
  }

  /**
   * Handle hostname image prediction cache retrieval request
   * @param message - The incoming message containing the hostname
   * @returns Promise resolving to cached image predictions for the hostname
   */
  public async getHostnameImagePredictionCache(
    message: BridgeMessage<{ hostname: string }>,
  ): Promise<IImagePrediction[]> {
    const { hostname } = message.data;

    if (!hostname) {
      throw new Error('Hostname is required to get cache predictions');
    }

    try {
      const cachedPredictions = await this.imageCacheService.getCachedPredictionsByHostname(hostname);
      if (cachedPredictions.length > 0) {
        logger
          .withTag('imageCacheController')
          .log(`Retrieved ${cachedPredictions.length} cached predictions for hostname: ${hostname}`);
      }
      return cachedPredictions;
    } catch (error) {
      logger
        .withTag('imageCacheController')
        .error('Error retrieving cached predictions for hostname:', hostname, error);
      throw error;
    }
  }
}
