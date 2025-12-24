import { processInferenceTask } from '@/utils/inference';
import { logger, extractUrlId } from '@/utils/logger';

import type { TabEventListener } from '@/entrypoints/background/events/tabEventListener';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { QueueService } from '@/entrypoints/background/services/queueService';
import type {
  IImagePrediction,
  IFramePrediction,
  IFrameMetadata,
  IHostSettings,
  IMediaMetadata,
  InferenceTask,
} from '@/utils/types';

type OnImagePredictionsCallback = (predictions: IImagePrediction[], hostname: string) => void;
type OnFramePredictionsCallback = (predictions: IFramePrediction[], hostname: string) => void;

export type InferenceInput =
  | { kind: 'src'; imageSrc: string }
  | { kind: 'bitmap'; imageSrc: string; bitmap: ImageBitmap; originalWidth: number; originalHeight: number }
  | { kind: 'blob'; imageSrc: string; blob: Blob; originalWidth: number; originalHeight: number };

export type ScheduleArgs = {
  input: InferenceInput;
  hostname: string;
  tabId: number;
  hostSettings: IHostSettings;
  mediaMetadata: IMediaMetadata;
};

export class InferenceOrchestrationService {
  private onImagePredictionsCallback?: OnImagePredictionsCallback;
  private onFramePredictionsCallback?: OnFramePredictionsCallback;

  constructor(
    private queueService: QueueService,
    private imageCacheService: ImageCacheService,
    private tabEventListener: TabEventListener,
  ) {
    this.setupEventHandlers();
  }

  setOnImagePredictionsCallback(callback: OnImagePredictionsCallback): void {
    this.onImagePredictionsCallback = callback;
  }

  setOnFramePredictionsCallback(callback: OnFramePredictionsCallback): void {
    this.onFramePredictionsCallback = callback;
  }

  async scheduleInferenceTask(args: ScheduleArgs): Promise<void> {
    const { input, hostname, tabId, hostSettings, mediaMetadata } = args;
    const { imageSrc } = input;

    // Only check cache for images, not video frames
    if (mediaMetadata.kind === 'image') {
      try {
        const cachedPredictions = await this.imageCacheService.getCachedPredictionsBySrc(imageSrc);

        if (cachedPredictions && cachedPredictions.length > 0) {
          logger.withTag('inferenceOrchestrationService').debug(`Cache hit for ${extractUrlId(imageSrc)} on src`);
          await this.imageCacheService.cachePredictions(
            cachedPredictions.map(prediction => ({
              ...prediction,
              hostname,
            })),
          );
          this.sendImagePredictionsToContent(cachedPredictions, hostname);
          return;
        }
      } catch (error) {
        logger
          .withTag('inferenceOrchestrationService')
          .warn(`Cache lookup failed for ${imageSrc}, proceeding with inference:`, error);
      }
    }

    const baseTask = {
      imageSrc,
      hostname,
      priority: this.calculatePriority(tabId),
      createdAt: new Date(),
      tabId,
      hostSettings,
      mediaMetadata,
    };

    let task: InferenceTask;
    if (input.kind === 'bitmap') {
      task = {
        ...baseTask,
        bitmap: input.bitmap,
        originalWidth: input.originalWidth,
        originalHeight: input.originalHeight,
      };
    } else if (input.kind === 'blob') {
      task = {
        ...baseTask,
        blob: input.blob,
        originalWidth: input.originalWidth,
        originalHeight: input.originalHeight,
      };
    } else {
      task = baseTask;
    }

    const taskType = input.kind;
    logger.withTag('inferenceOrchestrationService').debug(`Scheduling ${taskType} inference task for ${hostname}`);

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
      if (task.mediaMetadata.kind === 'frame') {
        const framePrediction = this.toFramePrediction(imagePrediction, task.mediaMetadata);
        this.sendFramePredictionsToContent([framePrediction], task.hostname);
      } else {
        await this.imageCacheService.cachePredictions([imagePrediction]);
        this.sendImagePredictionsToContent([imagePrediction], task.hostname);
      }
    } catch (error) {
      logger
        .withTag('inferenceOrchestrationService')
        .error(`Error handling success for ${extractUrlId(task.imageSrc)}:`, error);
    }
  }

  private toFramePrediction(imagePrediction: IImagePrediction, frameMetadata: IFrameMetadata): IFramePrediction {
    return {
      videoUrl: frameMetadata.videoUrl,
      src: imagePrediction.src,
      frameIndex: frameMetadata.frameIndex,
      sessionId: frameMetadata.sessionId,
      predictions: imagePrediction.predictions,
      width: imagePrediction.width,
      height: imagePrediction.height,
      hostname: imagePrediction.hostname,
      timestamp: imagePrediction.timestamp,
      cacheMetadata: imagePrediction.cacheMetadata,
      maskTransform: imagePrediction.maskTransform,
      processingTime: imagePrediction.processingTime,
    };
  }

  private sendImagePredictionsToContent(predictions: IImagePrediction[], hostname: string): void {
    try {
      if (this.onImagePredictionsCallback) {
        this.onImagePredictionsCallback(predictions, hostname);
      }
      logger.withTag('inferenceOrchestrationService').debug(`Sent ${predictions.length} image predictions`);
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending image predictions:', error);
    }
  }

  private sendFramePredictionsToContent(predictions: IFramePrediction[], hostname: string): void {
    try {
      if (this.onFramePredictionsCallback) {
        this.onFramePredictionsCallback(predictions, hostname);
      }
      logger.withTag('inferenceOrchestrationService').debug(`Sent ${predictions.length} frame predictions`);
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending frame predictions:', error);
    }
  }

  private calculatePriority(tabId: number): number {
    // Higher numbers = higher priority
    // Active tab gets highest priority, others get default
    const activeTabId = this.tabEventListener.getActiveTabId();
    return activeTabId === tabId ? 10 : 5;
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
