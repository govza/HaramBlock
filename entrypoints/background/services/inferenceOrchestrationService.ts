import { getInferenceBackend, processInferenceTask } from '@/utils/inference';
import { logger } from '@/utils/logger';
import { emitEvent } from '@/utils/logging';

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
  | { kind: 'src'; imageSrc: string; requestStartAt?: number; receivedAt?: number }
  | {
      kind: 'bitmap';
      imageSrc: string;
      bitmap: ImageBitmap;
      originalWidth: number;
      originalHeight: number;
      requestStartAt?: number;
      receivedAt?: number;
      fetchTime?: number;
      decodeTime?: number;
    }
  | {
      kind: 'blob';
      imageSrc: string;
      blob: Blob;
      originalWidth: number;
      originalHeight: number;
      requestStartAt?: number;
      receivedAt?: number;
      fetchTime?: number;
    };

export type ScheduleArgs = {
  input: InferenceInput;
  hostname: string;
  hostSettings: IHostSettings;
  mediaMetadata: IMediaMetadata;
  priority: number;
};

export class InferenceOrchestrationService {
  private onImagePredictionsCallback?: OnImagePredictionsCallback;
  private onFramePredictionsCallback?: OnFramePredictionsCallback;

  constructor(
    private queueService: QueueService,
    private imageCacheService: ImageCacheService,
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
    const { input, hostname, hostSettings, mediaMetadata } = args;
    const { imageSrc } = input;
    const startTime = Date.now();

    // Only check cache for images, not video frames
    if (mediaMetadata.kind === 'image') {
      try {
        const cachedPredictions = await this.imageCacheService.getCachedPredictionsBySrc(imageSrc);

        if (cachedPredictions && cachedPredictions.length > 0) {
          const predictionsWithHostname = cachedPredictions.map(prediction => ({
            ...prediction,
            hostname,
          }));
          await this.imageCacheService.cachePredictions(predictionsWithHostname);
          this.sendImagePredictionsToContent(predictionsWithHostname, hostname);

          emitEvent({
            src: imageSrc,
            hostname,
            context: 'background',
            status: 'cached',
            totalMs: Date.now() - startTime,
            cacheHit: true,
            detectionsCount: cachedPredictions.reduce((sum, p) => sum + p.predictions.length, 0),
            backend: getInferenceBackend(),
          });
          return;
        }
      } catch (error) {
        logger
          .withTag('inferenceOrchestrationService')
          .warn(`Cache lookup failed for ${imageSrc}, proceeding with inference:`, error);
      }
    }

    const queueStartAt = Date.now();
    const baseTask = {
      imageSrc,
      hostname,
      createdAt: new Date(),
      hostSettings,
      mediaMetadata,
      priority: args.priority,
      requestStartAt: input.requestStartAt,
      receivedAt: input.receivedAt,
      queueStartAt,
    };

    let task: InferenceTask;
    if (input.kind === 'bitmap') {
      task = {
        ...baseTask,
        bitmap: input.bitmap,
        originalWidth: input.originalWidth,
        originalHeight: input.originalHeight,
        fetchTime: input.fetchTime,
        decodeTime: input.decodeTime,
      };
    } else if (input.kind === 'blob') {
      task = {
        ...baseTask,
        blob: input.blob,
        originalWidth: input.originalWidth,
        originalHeight: input.originalHeight,
        fetchTime: input.fetchTime,
      };
    } else {
      task = baseTask;
    }

    this.queueService.enqueue(task).catch(error => {
      logger.withTag('inferenceOrchestrationService').error(`Failed to enqueue task for ${imageSrc}:`, error);
    });
  }

  private setupEventHandlers(): void {
    this.queueService.setTaskProcessingHandler(async (task: InferenceTask) => {
      try {
        const imagePrediction = await processInferenceTask(task);
        await this.handleSuccess(task, imagePrediction);

        emitEvent({
          src: task.imageSrc,
          hostname: task.hostname,
          context: 'background',
          status: 'success',
          totalMs: Date.now() - task.createdAt.getTime(),
          fetchMs: imagePrediction.processingTime.fetchTime,
          decodeMs: imagePrediction.processingTime.decodeTime,
          queueMs: imagePrediction.processingTime.queueTime,
          inferenceMs: imagePrediction.processingTime.inferenceTime,
          e2eMs: imagePrediction.processingTime.e2eTime,
          detectionsCount: imagePrediction.predictions.length,
          cacheHit: false,
          backend: getInferenceBackend(),
        });
      } catch (error) {
        emitEvent({
          src: task.imageSrc,
          hostname: task.hostname,
          context: 'background',
          status: 'error',
          totalMs: Date.now() - task.createdAt.getTime(),
          error: error instanceof Error ? error : new Error(String(error)),
          backend: getInferenceBackend(),
        });
        logger.withTag('inferenceOrchestrationService').error(`Error processing image ${task.imageSrc}:`, error);
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
      logger.withTag('inferenceOrchestrationService').error(`Error handling success for ${task.imageSrc}:`, error);
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
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending image predictions:', error);
    }
  }

  private sendFramePredictionsToContent(predictions: IFramePrediction[], hostname: string): void {
    try {
      if (this.onFramePredictionsCallback) {
        this.onFramePredictionsCallback(predictions, hostname);
      }
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending frame predictions:', error);
    }
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
