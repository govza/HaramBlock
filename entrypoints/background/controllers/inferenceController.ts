import { onMessage } from 'webext-bridge/background';

import { logger, extractUrlId } from '@/utils/logger';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type { IImageWithMetadata, IFrameWithMetadata, IVideo } from '@/utils/types';
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
    // POST /images - Process image (fallback path when MessageChannel is unavailable)
    onMessage('POST_IMAGE', this.handlePostImage.bind(this));
    // POST /videos - Start video session
    onMessage('POST_VIDEO', this.handlePostVideo.bind(this));
    // POST /videos/{id}/frames - Process video frame
    onMessage('POST_FRAME', this.handlePostFrame.bind(this));
  }

  /**
   * POST /images - Process image with AI model
   * @param message - The incoming message containing images and hostname
   */
  private async handlePostImage(
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
        kind: 'image',
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

  /**
   * POST /videos/{id}/frames - Process individual video frame
   * @param message - The incoming message containing frame data and hostname
   */
  private async handlePostFrame(
    message: BridgeMessage<{ hostname: string; frameData: IFrameWithMetadata }>,
  ): Promise<void> {
    const { hostname, frameData } = message.data;
    const { tabId } = message.sender;

    // Validate input
    if (!hostname) {
      logger.withTag('inferenceController').error('Hostname is required for video frame inference request');
      return;
    }

    if (!tabId) {
      logger.withTag('inferenceController').error('Tab ID is required to send results back to content script');
      return;
    }

    if (!frameData) {
      logger.withTag('inferenceController').error('Frame data is required for video frame inference request');
      return;
    }

    logger
      .withTag('inferenceController')
      .debug(
        `Received video frame (session=${frameData.sessionId || 'n/a'}) for ${extractUrlId(
          frameData.videoUrl,
        )} #${frameData.frameIndex} from ${hostname}`,
      );

    try {
      // Get host settings
      const hostSettings = await this.hostSettingsService.getHostSettings(hostname);

      // Schedule inference task for this frame
      await this.orchestrationService.scheduleInferenceTask({
        kind: 'frame',
        input: { kind: 'src', imageSrc: frameData.src },
        hostname,
        tabId,
        hostSettings,
        frameMetadata: frameData,
      });

      logger
        .withTag('inferenceController')
        .debug(`Successfully processed video frame ${frameData.frameIndex} for ${extractUrlId(frameData.videoUrl)}`);
    } catch (error) {
      logger.withTag('inferenceController').error(`Failed to process video frame ${frameData.frameIndex}:`, error);
    } finally {
      // Clean up the blob URL from content script
      try {
        globalThis.URL?.revokeObjectURL?.(frameData.src);
      } catch (error) {
        logger.withTag('inferenceController').warn('Failed to revoke blob URL:', error);
      }
    }
  }

  /**
   * POST /videos - Start video session
   */
  private handlePostVideo(
    message: BridgeMessage<{ hostname: string; video: Extract<IVideo, { type: 'start' }> }>,
  ): void {
    const { hostname } = message.data;
    const { video } = message.data;
    const { tabId } = message.sender;

    logger
      .withTag('inferenceController')
      .log(
        `POST /videos: sessionId=${video.sessionId} tab=${tabId} hostname=${hostname} url=${extractUrlId(video.videoUrl)} (${video.width}x${video.height})`,
      );

    // TODO: Initialize video session tracking
    // - Store session metadata
    // - Prepare frame aggregation
  }
}
