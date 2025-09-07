import { onMessage } from 'webext-bridge/background';

import { logger, extractUrlId } from '@/utils/logger';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type { IImageWithMetadata } from '@/utils/types';
import type { BridgeMessage } from 'webext-bridge';

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
    message: BridgeMessage<{ hostname: string; imageData: IImageWithMetadata }>,
  ): Promise<void> {
    const { hostname } = message.data;
    const { src, metadata } = message.data.imageData;
    const { tabId } = message.sender;

    // Validate input
    if (!hostname) {
      logger.withTag('inferenceController').error('Hostname is required for inference request');
      return;
    }

    if (!tabId) {
      logger.withTag('inferenceController').error('Tab ID is required to send results back to content script');
      return;
    }

    logger
      .withTag('inferenceController')
      .log(`Received inference request for ${extractUrlId(src)} from hostname: ${hostname}`);

    // Get host settings once for all images in this batch
    try {
      const hostSettings = await this.hostSettingsService.getHostSettings(hostname);

      // Schedule inference task for image
      await this.orchestrationService.scheduleInferenceTask({
        input: { kind: 'src', imageSrc: src },
        hostname,
        tabId,
        hostSettings,
        imageMetadata: metadata,
      });
    } catch (error) {
      logger.withTag('inferenceController').error('Failed to get host settings for hostname:', hostname, error);
    }
  }
}
