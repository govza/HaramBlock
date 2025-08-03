import { type BridgeMessage } from 'webext-bridge';
import { onMessage } from 'webext-bridge/background';

import { PredictionCacheService } from '@/entrypoints/background/services/predictionCacheService';
import { logger } from '@/utils/logger';
import { type IImagePrediction } from '@/utils/types';

export class PredictionCacheController {
  private readonly predictionCacheService: PredictionCacheService;

  constructor() {
    this.predictionCacheService = new PredictionCacheService();
  }

  /**
   * Initialize message listeners (API)
   */
  public initialize(): void {
    onMessage(
      'GET_HOSTNAME_IMAGE_PREDICTION_CACHE',
      this.getHostnameImagePredictionCache.bind(this),
    );
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
      const cachedPredictions =
        await this.predictionCacheService.getCachedPredictionsByHostname(
          hostname,
        );
      return cachedPredictions;
    } catch (error) {
      logger
        .withTag('predictionCacheController')
        .error(
          'Error retrieving cached predictions for hostname:',
          hostname,
          error,
        );
      throw error;
    }
  }
}
