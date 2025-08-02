import { type BridgeMessage } from 'webext-bridge';
import { onMessage } from 'webext-bridge/background';

import { InferenceService } from '@/entrypoints/background/services/inferenceService';
import { PredictionCacheService } from '@/entrypoints/background/services/predictionCacheService';
import { logger } from '@/utils/logger';

/**
 * InferenceController handles AI model inference requests from content scripts
 * Coordinates between content scripts and the inference service
 */
export class InferenceController {
  private readonly inferenceService: InferenceService;
  private readonly predictionCacheService: PredictionCacheService;

  constructor() {
    this.predictionCacheService = new PredictionCacheService();
    this.inferenceService = new InferenceService(this.predictionCacheService);
  }

  /**
   * Initialize message listeners (API)
   */
  public initialize(): void {
    onMessage('POST_INFERENCE_IMAGES', this.handleInferenceRequest.bind(this));
  }

  /**
   * Handle inference request from content script
   * @param message - The incoming message containing images and hostname
   */
  public async handleInferenceRequest(
    message: BridgeMessage<{ hostname: string; imageSrcs: string[] }>,
  ): Promise<void> {
    const { hostname, imageSrcs } = message.data;
    const { tabId } = message.sender;

    // Validate input
    if (!hostname) {
      logger
        .withTag('inferenceController')
        .error('Hostname is required for inference request');
      return;
    }

    if (!imageSrcs || !Array.isArray(imageSrcs) || imageSrcs.length === 0) {
      logger
        .withTag('inferenceController')
        .error('Image sources array is required and must not be empty');
      return;
    }

    if (!tabId) {
      logger
        .withTag('inferenceController')
        .error('Tab ID is required to send results back to content script');
      return;
    }

    try {
      logger
        .withTag('inferenceController')
        .log(
          `Received inference request for ${imageSrcs.length} images from hostname: ${hostname}`,
        );

      // Filter out invalid/empty image sources
      const validImageSrcs = imageSrcs.filter(
        src => src && src.trim().length > 0,
      );

      if (validImageSrcs.length === 0) {
        logger
          .withTag('inferenceController')
          .warn('No valid image sources provided for inference');
        return;
      }

      // Start inference processing (fire-and-forget)
      this.inferenceService
        .processImages(validImageSrcs, hostname, tabId)
        .catch(error => {
          logger
            .withTag('inferenceController')
            .error('Background inference processing failed:', error);
        });

      logger
        .withTag('inferenceController')
        .debug(
          `Queued ${validImageSrcs.length} images for inference processing`,
        );
    } catch (error) {
      logger
        .withTag('inferenceController')
        .error('Error handling inference request:', error);
    }

    return Promise.resolve();
  }
}
