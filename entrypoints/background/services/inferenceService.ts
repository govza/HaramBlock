/* eslint-disable no-await-in-loop */
import { sendMessage } from 'webext-bridge/background';

import { type PredictionCacheService } from '@/entrypoints/background/services/predictionCacheService';
import { getEffectiveHostname } from '@/utils/db/hostnameUtil';
import { logger } from '@/utils/logger';
import { type IImagePrediction } from '@/utils/types';

/**
 * InferenceService handles AI model inference requests
 * Coordinates AI processing, caching, and response delivery
 */
export class InferenceService {
  private predictionCacheService: PredictionCacheService;

  constructor(predictionCacheService: PredictionCacheService) {
    this.predictionCacheService = predictionCacheService;
  }
  /**
   * Process images through AI model and return predictions
   * @param imageSrcs - Array of image source URLs
   * @param hostname - Hostname for cache storage
   * @param tabId - Tab ID for sending results back to content script
   * @returns Promise resolving when processing is complete
   */
  async processImages(
    imageSrcs: string[],
    hostname: string,
    tabId: number,
  ): Promise<void> {
    logger
      .withTag('inferenceService')
      .debug(`Processing ${imageSrcs.length} images for hostname: ${hostname}`);

    try {
      // Process images in batches and send results as they complete
      await this.processBatchedInference(imageSrcs, hostname, tabId);

      logger
        .withTag('inferenceService')
        .debug(
          `Successfully completed processing all ${imageSrcs.length} images`,
        );
    } catch (error) {
      logger
        .withTag('inferenceService')
        .error('Error processing images in inference service:', error);
      throw error;
    }
  }

  /**
   * Process images in batches and send results as they complete
   * @param imageSrcs - Array of image source URLs
   * @param hostname - Hostname for cache storage
   * @param tabId - Tab ID for sending results back to content script
   */
  private async processBatchedInference(
    imageSrcs: string[],
    hostname: string,
    tabId: number,
  ): Promise<void> {
    const batchSize = 5; // Process 5 images per batch
    const totalImages = imageSrcs.length;
    const totalBatches = Math.ceil(totalImages / batchSize);
    let processedCount = 0;

    logger
      .withTag('inferenceService')
      .debug(
        `Processing ${totalImages} images in ${totalBatches} batches of ${batchSize}`,
      );

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIndex = batchIndex * batchSize;
      const endIndex = Math.min(startIndex + batchSize, totalImages);
      const batchImageSrcs = imageSrcs.slice(startIndex, endIndex);

      try {
        logger
          .withTag('inferenceService')
          .debug(
            `Processing batch ${batchIndex + 1}/${totalBatches}: ${batchImageSrcs.length} images`,
          );

        // Simulate AI processing for this batch
        await this.simulateAiProcessing(batchImageSrcs.length);

        // Generate mock predictions for this batch
        const batchPredictions = this.generateMockPredictions(
          batchImageSrcs,
          hostname,
        );

        // Cache the predictions
        await this.predictionCacheService.cachePredictions(
          batchPredictions,
          hostname,
        );

        processedCount += batchPredictions.length;

        // Send batch results to content script
        await this.sendPredictionsToContent(batchPredictions, tabId);

        logger
          .withTag('inferenceService')
          .debug(
            `Completed batch ${batchIndex + 1}/${totalBatches}: ${processedCount}/${totalImages} images processed`,
          );
      } catch (error) {
        logger
          .withTag('inferenceService')
          .error(`Error processing batch ${batchIndex + 1}:`, error);
        // Continue with remaining batches even if one fails
      }
    }
  }

  /**
   * Send predictions to content script using webext-bridge
   * @param predictions - Array of predictions to send
   * @param tabId - Tab ID to send to
   * @param hostname - Hostname for the predictions
   */
  private async sendPredictionsToContent(
    predictions: IImagePrediction[],
    tabId: number,
  ): Promise<void> {
    try {
      await sendMessage(
        'INFERENCE_PREDICTIONS',
        {
          predictions,
        },
        { context: 'content-script', tabId },
      );

      logger
        .withTag('inferenceService')
        .debug(
          `Sent ${predictions.length} predictions to content script (tab ${tabId})`,
        );
    } catch (error) {
      logger
        .withTag('inferenceService')
        .error('Error sending predictions to content script:', error);
      // Don't throw here - caching succeeded, delivery failed
    }
  }

  /**
   * Simulate AI processing time
   * @param imageCount - Number of images being processed
   */
  private async simulateAiProcessing(imageCount: number): Promise<void> {
    // Simulate processing time: 500ms base + 200ms per image
    const processingTime = 500 + imageCount * 200;
    logger
      .withTag('inferenceService')
      .debug(`Simulating AI processing for ${processingTime}ms...`);
    await new Promise(resolve => setTimeout(resolve, processingTime));
  }

  /**
   * Generate mock predictions for images
   * @param imageSrcs - Array of image source URLs
   * @param hostname - Hostname for the predictions
   * @returns Array of mock image predictions
   */
  private generateMockPredictions(
    imageSrcs: string[],
    hostname: string,
  ): IImagePrediction[] {
    const predictions: IImagePrediction[] = [];

    for (const src of imageSrcs) {
      const mockPrediction = this.createMockPrediction(src, hostname);
      predictions.push(mockPrediction);
    }

    return predictions;
  }

  /**
   * Create a single mock prediction for an image
   * @param src - Image source URL
   * @param hostname - Hostname
   * @returns Mock image prediction
   */
  private createMockPrediction(
    src: string,
    hostname: string,
  ): IImagePrediction {
    const now = Date.now();

    // Generate random mock predictions with different classes
    const mockClasses = ['person', 'vehicle', 'animal', 'object'];
    const randomClass =
      mockClasses[Math.floor(Math.random() * mockClasses.length)] || 'object';

    // Generate random dimensions (typical web image sizes)
    const imageWidth = 800 + Math.floor(Math.random() * 400); // 800-1200
    const imageHeight = 600 + Math.floor(Math.random() * 300); // 600-900

    // Generate random bounding box
    const bboxX = Math.floor(Math.random() * (imageWidth * 0.3));
    const bboxY = Math.floor(Math.random() * (imageHeight * 0.3));
    const bboxWidth = Math.floor(
      imageWidth * 0.2 + Math.random() * (imageWidth * 0.3),
    );
    const bboxHeight = Math.floor(
      imageHeight * 0.2 + Math.random() * (imageHeight * 0.3),
    );

    // Generate polygon points around the bounding box
    const polygon = [
      { x: bboxX, y: bboxY },
      { x: bboxX + bboxWidth, y: bboxY },
      { x: bboxX + bboxWidth, y: bboxY + bboxHeight },
      { x: bboxX, y: bboxY + bboxHeight },
    ];

    return {
      hostname: getEffectiveHostname(hostname),
      src,
      imageWidth,
      imageHeight,
      predictions: [
        {
          classId: Math.floor(Math.random() * 10) + 1,
          className: randomClass,
          probability: 0.7 + Math.random() * 0.3, // 0.7 to 1.0
          boundingBox: {
            x: bboxX,
            y: bboxY,
            width: bboxWidth,
            height: bboxHeight,
          },
          polygon,
        },
      ],
      timestamp: now,
      cacheMetadata: {
        createdAt: now,
        accessedAt: now,
        maxAge: 3600, // Cache for 1 hour
        cacheControl: 'max-age=3600',
        contentType: 'image/jpeg',
      },
    };
  }

  /**
   * Batch process multiple inference requests
   * @param requests - Array of inference requests
   */
  async processBatch(
    requests: Array<{ imageSrcs: string[]; hostname: string; tabId: number }>,
  ): Promise<void> {
    logger
      .withTag('inferenceService')
      .debug(`Processing batch of ${requests.length} inference requests`);

    try {
      // Process requests in parallel with a concurrency limit
      const batchSize = 3; // Process max 3 requests simultaneously

      for (let i = 0; i < requests.length; i += batchSize) {
        const batch = requests.slice(i, i + batchSize);
        const batchPromises = batch.map(request =>
          this.processImages(
            request.imageSrcs,
            request.hostname,
            request.tabId,
          ),
        );

        await Promise.all(batchPromises);
      }

      logger
        .withTag('inferenceService')
        .debug(`Successfully processed batch of ${requests.length} requests`);
    } catch (error) {
      logger
        .withTag('inferenceService')
        .error('Error processing inference batch:', error);
      throw error;
    }
  }
}
