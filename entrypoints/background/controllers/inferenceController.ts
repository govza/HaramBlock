import { type BridgeMessage } from 'webext-bridge';
import { onMessage } from 'webext-bridge/background';

import { type HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import { type InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import { logger } from '@/utils/logger';
import { type IImageWithMetadata } from '@/utils/types';

/**
 * InferenceController handles AI model inference requests from content scripts
 * Coordinates between content scripts and the inference orchestration service
 */
export class InferenceController {
  constructor(
    private readonly orchestrationService: InferenceOrchestrationService,
    private readonly hostSettingsService: HostSettingsService,
  ) {}

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
    message: BridgeMessage<
      {
        hostname: string;
        imageDatas: IImageWithMetadata[];
      } & Record<string, any>
    >,
  ): Promise<void> {
    const { hostname, imageDatas } = message.data;
    const { tabId } = message.sender;

    // Validate input
    if (!hostname) {
      logger.withTag('inferenceController').error('Hostname is required for inference request');
      return;
    }

    if (!imageDatas || !Array.isArray(imageDatas) || imageDatas.length === 0) {
      logger.withTag('inferenceController').error('Image data array is required and must not be empty');
      return;
    }

    if (!tabId) {
      logger.withTag('inferenceController').error('Tab ID is required to send results back to content script');
      return;
    }

    logger
      .withTag('inferenceController')
      .log(`Received inference request for ${imageDatas.length} images from hostname: ${hostname}`);

    // Filter out invalid/empty image sources
    const validImageDatas = imageDatas.filter(imageData => imageData.src && imageData.src.trim().length > 0);

    if (validImageDatas.length === 0) {
      logger.withTag('inferenceController').warn('No valid image data provided for inference');
      return;
    }

    // Get host settings once for all images in this batch
    try {
      const hostSettings = await this.hostSettingsService.getHostSettings(hostname);

      // Schedule inference tasks for each image
      await Promise.all(
        validImageDatas.map(imageData =>
          this.orchestrationService.scheduleInferenceTask(
            imageData.src,
            hostname,
            tabId,
            hostSettings,
            imageData.metadata,
          ),
        ),
      );
    } catch (error) {
      logger.withTag('inferenceController').error('Failed to get host settings for hostname:', hostname, error);
    }
  }
}
