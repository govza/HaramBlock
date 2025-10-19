import { sendMessage } from 'webext-bridge/background';

import { logger, extractUrlId } from '@/utils/logger';

import type { TabEventListener } from '@/entrypoints/background/events/tabEventListener';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { PredictionService } from '@/entrypoints/background/services/predictionService';
import type { QueueService } from '@/entrypoints/background/services/queueService';
import type { IImagePrediction, IHostSettings, IImageMetadata, InferenceTask } from '@/utils/types';

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
  constructor(
    private queueService: QueueService,
    private processingService: PredictionService,
    private imageCacheService: ImageCacheService,
    private tabEventListener: TabEventListener,
  ) {
    this.setupEventHandlers();
    this.setupTabActivationHandler();
  }

  async scheduleInferenceTask(args: ScheduleArgs): Promise<string> {
    const { input, hostname, tabId, hostSettings, imageMetadata } = args;
    const taskId = crypto.randomUUID();
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
        await this.sendPredictionsToContent(cachedPredictions, tabId);
        return taskId;
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
            id: taskId,
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
            id: taskId,
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
      logger.withTag('inferenceOrchestrationService').error(`Failed to enqueue task ${task.id}:`, error);
    });

    return task.id;
  }

  private setupEventHandlers(): void {
    this.queueService.setTaskProcessingHandler(async (task: InferenceTask) => {
      try {
        const imagePrediction = await this.processingService.processInferenceTask(task);
        await this.handleSuccess(task, imagePrediction);
      } catch (error) {
        logger.withTag('inferenceOrchestrationService').error(`Error processing task ${task.id}:`, error);
      }
    });
  }

  private async handleSuccess(task: InferenceTask, imagePrediction: IImagePrediction): Promise<void> {
    try {
      await this.imageCacheService.cachePredictions([imagePrediction]);
      await this.sendPredictionsToContent([imagePrediction], task.tabId);
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error(`Error handling success for task ${task.id}:`, error);
    }
  }

  private async sendPredictionsToContent(predictions: IImagePrediction[], tabId: number): Promise<void> {
    try {
      await sendMessage('ON_INFERENCE_PREDICTIONS', { predictions }, { context: 'content-script', tabId });

      logger
        .withTag('inferenceOrchestrationService')
        .debug(`Sent ${predictions.length} predictions to content script (tab ${tabId})`);
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending predictions to content script:', error);
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
