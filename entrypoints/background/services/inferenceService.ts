import { sendMessage } from 'webext-bridge/background';

import { type InferenceTask } from '@/entrypoints/background/domain/models';
import { type TabEventListener } from '@/entrypoints/background/events/tabEventListener';
import { type PredictionCacheService } from '@/entrypoints/background/services/predictionCacheService';
import { type PredictionService } from '@/entrypoints/background/services/predictionService';
import { type QueueService } from '@/entrypoints/background/services/queueService';
import { logger } from '@/utils/logger';
import {
  type IImagePrediction,
  type IHostSettings,
  type IImageMetadata,
} from '@/utils/types';

export class InferenceService {
  constructor(
    private queueService: QueueService,
    private processingService: PredictionService,
    private predictionCacheService: PredictionCacheService,
    private tabEventListener: TabEventListener,
  ) {
    this.setupEventHandlers();
    this.setupTabActivationHandler();
  }

  async scheduleInferenceTask(
    imageSrc: string,
    hostname: string,
    tabId: number,
    hostSettings: IHostSettings,
    imageMetadata?: IImageMetadata,
  ): Promise<string> {
    const taskId = crypto.randomUUID();

    // Check cache first to avoid expensive processing
    try {
      const cachedPredictions =
        await this.predictionCacheService.getCachedPredictionsBySrc(imageSrc);

      if (cachedPredictions && cachedPredictions.length > 0) {
        // Maybe we have image cached on different hostname (cdn, etc.)
        await this.sendPredictionsToContent(cachedPredictions, tabId);
        return taskId;
      }
    } catch (error) {
      logger
        .withTag('inferenceService')
        .warn(
          `Cache lookup failed for ${imageSrc}, proceeding with inference:`,
          error,
        );
    }

    // No cache hit, create inference task
    const task: InferenceTask = {
      id: taskId,
      imageSrc,
      hostname,
      priority: this.calculatePriority(tabId),
      createdAt: new Date(),
      tabId,
      hostSettings,
      imageMetadata,
    };

    logger
      .withTag('inferenceService')
      .debug(`Scheduling inference task ${task.id} for ${hostname}`);

    // Add to queue (fire-and-forget for immediate response)
    this.queueService.enqueue(task).catch(error => {
      logger
        .withTag('inferenceService')
        .error(`Failed to enqueue task ${task.id}:`, error);
    });

    return task.id;
  }

  private setupEventHandlers(): void {
    this.queueService.setTaskProcessingHandler(async (task: InferenceTask) => {
      try {
        const imagePrediction =
          await this.processingService.processInferenceTask(task);
        await this.handleSuccess(task, imagePrediction);
      } catch (error) {
        await this.handleError(task, error as Error);
      }
    });
  }

  private async handleSuccess(
    task: InferenceTask,
    imagePrediction: IImagePrediction,
  ): Promise<void> {
    try {
      await this.predictionCacheService.cachePredictions([imagePrediction]);
      await this.sendPredictionsToContent([imagePrediction], task.tabId);
    } catch (error) {
      logger
        .withTag('inferenceService')
        .error(`Error handling success for task ${task.id}:`, error);
    }
  }

  private async handleError(task: InferenceTask, error: Error): Promise<void> {
    logger.withTag('inferenceService').error(`Task ${task.id} failed:`, error);

    // Send error to content script if tabId provided
    try {
      await sendMessage(
        'INFERENCE_ERROR',
        {
          taskId: task.id,
          error: error.message,
          imageSrc: task.imageSrc,
        },
        { context: 'content-script', tabId: task.tabId },
      );
    } catch (sendError) {
      logger
        .withTag('inferenceService')
        .error(
          'Error sending error notification to content script:',
          sendError,
        );
    }
  }

  private async sendPredictionsToContent(
    predictions: IImagePrediction[],
    tabId: number,
  ): Promise<void> {
    if (
      !predictions ||
      predictions.length === 0 ||
      !predictions.some(p => p.predictions.length != 0)
    ) {
      logger
        .withTag('inferenceService')
        .warn('No predictions to send to content script');
      return;
    }

    try {
      await sendMessage(
        'INFERENCE_PREDICTIONS',
        { predictions },
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
        .withTag('inferenceService')
        .debug(
          `Active tab changed to ${activeTabId}, new tasks will get priority boost`,
        );
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
