import { processInferenceTask } from '@/utils/inference';
import { logger, extractUrlId } from '@/utils/logger';

import type { TabEventListener } from '@/entrypoints/background/events/tabEventListener';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { QueueService } from '@/entrypoints/background/services/queueService';
import type { IImagePrediction, IHostSettings, IImageMetadata, InferenceTask } from '@/utils/types';

type OnPredictionsCallback = (predictions: IImagePrediction[], hostname: string) => void;

export type InferenceInput =
  | { kind: 'src'; imageSrc: string }
  | { kind: 'bitmap'; imageSrc: string; bitmap: ImageBitmap; originalWidth: number; originalHeight: number };

export type ScheduleArgs = {
  input: InferenceInput;
  hostname: string;
  tabId: number;
  hostSettings: IHostSettings;
  imageMetadata: IImageMetadata;
};

export class InferenceOrchestrationService {
  private onPredictionsCallback?: OnPredictionsCallback;

  constructor(
    private queueService: QueueService,
    private imageCacheService: ImageCacheService,
    private tabEventListener: TabEventListener,
  ) {
    this.setupEventHandlers();
    this.setupTabActivationHandler();
  }

  setOnPredictionsCallback(callback: OnPredictionsCallback): void {
    this.onPredictionsCallback = callback;
  }

  async scheduleInferenceTask(args: ScheduleArgs): Promise<void> {
    const { input, hostname, tabId, hostSettings, imageMetadata } = args;
    const { imageSrc } = input;

    // Check cache first to avoid expensive processing
    try {
      const cachedPredictions = await this.imageCacheService.getCachedPredictionsBySrc(imageSrc);

      if (cachedPredictions && cachedPredictions.length > 0) {
        // Maybe we have image cached on different hostname (cdn, etc.)
        logger.withTag('inferenceOrchestrationService').debug(`Cache hit for ${extractUrlId(imageSrc)} on src`);
        // Save cache as hostname key as well
        await this.imageCacheService.cachePredictions(
          cachedPredictions.map(prediction => ({
            ...prediction,
            hostname,
          })),
        );
        this.sendPredictionsToContent(cachedPredictions, hostname);
        return;
      }
    } catch (error) {
      logger
        .withTag('inferenceOrchestrationService')
        .warn(`Cache lookup failed for ${imageSrc}, proceeding with inference:`, error);
    }

    // No cache hit, create inference task
    const task: InferenceTask =
      input.kind === 'bitmap'
        ? {
            imageSrc,
            hostname,
            priority: this.calculatePriority(tabId),
            createdAt: new Date(),
            tabId,
            hostSettings,
            imageMetadata,
            bitmap: input.bitmap,
            originalWidth: input.originalWidth,
            originalHeight: input.originalHeight,
          }
        : {
            imageSrc,
            hostname,
            priority: this.calculatePriority(tabId),
            createdAt: new Date(),
            tabId,
            hostSettings,
            imageMetadata,
          };

    const taskType = input.kind === 'bitmap' ? 'bitmap' : 'src';
    logger.withTag('inferenceOrchestrationService').debug(`Scheduling ${taskType} inference task for ${hostname}`);

    // Add to queue (fire-and-forget for immediate response)
    this.queueService.enqueue(task).catch(error => {
      logger
        .withTag('inferenceOrchestrationService')
        .error(`Failed to enqueue task for ${extractUrlId(imageSrc)}:`, error);
    });
  }

  private setupEventHandlers(): void {
    this.queueService.setTaskProcessingHandler(async (task: InferenceTask) => {
      try {
        const imagePrediction = await processInferenceTask(task);
        await this.handleSuccess(task, imagePrediction);
      } catch (error) {
        logger
          .withTag('inferenceOrchestrationService')
          .error(`Error processing image ${extractUrlId(task.imageSrc)}:`, error);
      }
    });
  }

  private async handleSuccess(task: InferenceTask, imagePrediction: IImagePrediction): Promise<void> {
    try {
      await this.imageCacheService.cachePredictions([imagePrediction]);
      this.sendPredictionsToContent([imagePrediction], task.hostname);
    } catch (error) {
      logger
        .withTag('inferenceOrchestrationService')
        .error(`Error handling success for ${extractUrlId(task.imageSrc)}:`, error);
    }
  }

  private sendPredictionsToContent(predictions: IImagePrediction[], hostname: string): void {
    try {
      if (this.onPredictionsCallback) {
        this.onPredictionsCallback(predictions, hostname);
      }

      logger.withTag('inferenceOrchestrationService').debug(`Sent ${predictions.length} predictions via callback`);
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending predictions:', error);
    }
  }

  private calculatePriority(tabId: number): number {
    // Higher numbers = higher priority
    // Active tab gets highest priority, others get default
    const activeTabId = this.tabEventListener.getActiveTabId();
    return activeTabId === tabId ? 10 : 5;
  }

  private setupTabActivationHandler(): void {
    this.tabEventListener.setOnTabActivatedCallback((activeTabId: number) => {
      logger
        .withTag('inferenceOrchestrationService')
        .debug(`Active tab changed to ${activeTabId}, new tasks will get priority boost`);
    });
  }

  // Public methods for monitoring
  getQueueStatus(): { size: number; pending: number; isIdle: boolean } {
    return {
      size: this.queueService.getQueueSize(),
      pending: this.queueService.getPendingCount(),
      isIdle: this.queueService.isIdle(),
    };
  }

  pauseProcessing(): void {
    this.queueService.pause();
  }

  startProcessing(): void {
    this.queueService.start();
  }

  clearQueue(): void {
    this.queueService.clear();
  }
}
