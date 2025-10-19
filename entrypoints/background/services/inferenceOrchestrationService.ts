import { sendMessage } from 'webext-bridge/background';

import { logger, extractUrlId } from '@/utils/logger';

import type { TabEventListener } from '@/entrypoints/background/events/tabEventListener';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { PredictionService } from '@/entrypoints/background/services/predictionService';
import type { QueueService } from '@/entrypoints/background/services/queueService';
import type {
  IImagePrediction,
  IHostSettings,
  IImageMetadata,
  IFramePrediction,
  IFrameWithMetadata,
} from '@/utils/types';
import type { InferenceTask, ImageInferenceTask, FrameInferenceTask } from '@/utils/types/model';

export type InferenceInput =
  | { kind: 'src'; imageSrc: string }
  | { kind: 'bitmap'; imageSrc: string; bitmap: ImageBitmap; originalWidth: number; originalHeight: number };

// Schedule arguments for image inference
export type ScheduleImageArgs = {
  kind: 'image';
  input: InferenceInput;
  hostname: string;
  tabId: number;
  hostSettings: IHostSettings;
  imageMetadata: IImageMetadata;
};

// Schedule arguments for frame inference
export type ScheduleFrameArgs = {
  kind: 'frame';
  input: InferenceInput;
  hostname: string;
  tabId: number;
  hostSettings: IHostSettings;
  frameMetadata: IFrameWithMetadata;
};

export type ScheduleArgs = ScheduleImageArgs | ScheduleFrameArgs;

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

  async scheduleInferenceTask(args: ScheduleArgs): Promise<void> {
    if (args.kind === 'image') {
      return this.scheduleImageInferenceTask(args);
    } else if (args.kind === 'frame') {
      return this.scheduleFrameInferenceTask(args);
    } else {
      const errorMsg = `Unknown task kind: ${(args as { kind?: string }).kind}`;
      logger.withTag('inferenceOrchestrationService').error(errorMsg);
      return Promise.reject(new Error(errorMsg));
    }
  }

  private async scheduleImageInferenceTask(args: ScheduleImageArgs): Promise<void> {
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
        await this.sendPredictionsToContent(cachedPredictions, tabId);
        return Promise.resolve();
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
            kind: 'image',
            transport: 'transferable',
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
            kind: 'image',
            transport: 'serializable',
            imageSrc,
            hostname,
            priority: this.calculatePriority(tabId),
            createdAt: new Date(),
            tabId,
            hostSettings,
            imageMetadata,
          };

    logger
      .withTag('inferenceOrchestrationService')
      .debug(`Scheduling ${input.kind} image inference task for ${hostname}`);

    // Add to queue (fire-and-forget for immediate response)
    this.queueService.enqueue(task).catch(error => {
      logger
        .withTag('inferenceOrchestrationService')
        .error(`Failed to enqueue image task for ${extractUrlId(imageSrc)}:`, error);
    });

    return Promise.resolve();
  }

  private async scheduleFrameInferenceTask(args: ScheduleFrameArgs): Promise<void> {
    const { input, hostname, tabId, hostSettings, frameMetadata } = args;
    const { imageSrc } = input;

    // Create frame inference task without cache check (frames are not cached)
    const task: FrameInferenceTask =
      input.kind === 'bitmap'
        ? {
            kind: 'frame',
            transport: 'transferable',
            imageSrc,
            hostname,
            priority: this.calculatePriority(tabId),
            createdAt: new Date(),
            tabId,
            hostSettings,
            frameMetadata,
            bitmap: input.bitmap,
            originalWidth: input.originalWidth,
            originalHeight: input.originalHeight,
          }
        : {
            kind: 'frame',
            transport: 'serializable',
            imageSrc,
            hostname,
            priority: this.calculatePriority(tabId),
            createdAt: new Date(),
            tabId,
            hostSettings,
            frameMetadata,
          };

    logger
      .withTag('inferenceOrchestrationService')
      .debug(`Scheduling ${input.kind} frame inference task for ${hostname}`);

    // Add to queue (fire-and-forget for immediate response)
    this.queueService.enqueue(task).catch(error => {
      logger
        .withTag('inferenceOrchestrationService')
        .error(`Failed to enqueue frame task for ${extractUrlId(imageSrc)}:`, error);
    });

    return Promise.resolve();
  }

  private setupEventHandlers(): void {
    this.queueService.setTaskProcessingHandler(async (task: InferenceTask) => {
      try {
        const imagePrediction = await this.processingService.processInferenceTask(task);
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
      if (task.kind === 'image') {
        await this.handleSuccessForImage(task, imagePrediction);
      } else if (task.kind === 'frame') {
        await this.handleSuccessForFrame(task, imagePrediction);
      }
    } catch (error) {
      logger
        .withTag('inferenceOrchestrationService')
        .error(`Error handling success for ${task.kind} ${extractUrlId(task.imageSrc)}:`, error);
    }
  }

  private async handleSuccessForImage(task: ImageInferenceTask, imagePrediction: IImagePrediction): Promise<void> {
    await this.imageCacheService.cachePredictions([imagePrediction]);
    await this.sendPredictionsToContent([imagePrediction], task.tabId);
  }

  private async handleSuccessForFrame(task: FrameInferenceTask, imagePrediction: IImagePrediction): Promise<void> {
    const framePrediction = this.createFramePrediction(task, imagePrediction);
    await this.sendFramePredictionsToContent([framePrediction], task.tabId);
  }

  private createFramePrediction(task: FrameInferenceTask, imagePrediction: IImagePrediction): IFramePrediction {
    const { frameMetadata } = task;

    return {
      // Base fields
      sessionId: frameMetadata.sessionId,
      hostname: imagePrediction.hostname,
      width: imagePrediction.width,
      height: imagePrediction.height,
      frameIndex: frameMetadata.frameIndex,
      videoUrl: frameMetadata.videoUrl, // Actual video URL (for DOM matching)
      src: task.imageSrc, // Blob URL of the extracted frame (for inference)
      predictions: imagePrediction.predictions,
      timestamp: frameMetadata.timestampSec,
      cacheMetadata: imagePrediction.cacheMetadata,
      maskTransform: imagePrediction.maskTransform,
      // Processing times aligned with IFramePrediction
      processingTime: {
        fetchTime: imagePrediction.processingTime.fetchTime,
        bitmapTime: imagePrediction.processingTime.bitmapTime,
        inferenceTime: imagePrediction.processingTime.inferenceTime,
      },
    };
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

  private async sendFramePredictionsToContent(predictions: IFramePrediction[], tabId: number): Promise<void> {
    try {
      await sendMessage('ON_FRAME_PREDICTIONS', { predictions }, { context: 'content-script', tabId });

      logger
        .withTag('inferenceOrchestrationService')
        .debug(`Sent ${predictions.length} frame predictions to content script (tab ${tabId})`);
    } catch (error) {
      logger
        .withTag('inferenceOrchestrationService')
        .error('Error sending frame predictions to content script:', error);
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
