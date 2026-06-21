import { getCurrentModelId } from '@inference-runtime';

import { BatchCollector } from '@/entrypoints/background/services/batchCollector';
import { getBatchCap, getInferenceBackend, processInferenceBatch, processInferenceTask } from '@/utils/inference';
import { logger } from '@/utils/logger';
import { emitEvent } from '@/utils/logging';

import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { QueueService } from '@/entrypoints/background/services/queueService';
import type {
  IImagePrediction,
  IFramePrediction,
  IFrameMetadata,
  IGifFrameMetadata,
  IGifFramePrediction,
  IHostSettings,
  IMediaMetadata,
  InferenceTask,
} from '@/utils/types';

type OnImagePredictionsCallback = (predictions: IImagePrediction[], hostname: string) => void;
type OnFramePredictionsCallback = (predictions: IFramePrediction[], hostname: string) => void;
type OnGifFramePredictionsCallback = (predictions: IGifFramePrediction[], hostname: string) => void;

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
  private onGifFramePredictionsCallback?: OnGifFramePredictionsCallback;

  // Batches concurrent queue tasks into one session.run for dynamic-batch models.
  private batchCollector = new BatchCollector<InferenceTask, IImagePrediction>(tasks => processInferenceBatch(tasks), {
    getCap: getBatchCap,
    getPriority: task => task.priority,
  });

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

  setOnGifFramePredictionsCallback(callback: OnGifFramePredictionsCallback): void {
    this.onGifFramePredictionsCallback = callback;
  }

  // Match queue concurrency to the active model's batch cap (1 when batching is off). Admitting more
  // than one batch lets low-priority tasks form a second collector batch ahead of a later active-tab
  // task that p-queue has not admitted yet. Call after init and on every model switch.
  refreshConcurrency(): void {
    this.queueService.setConcurrency(getBatchCap());
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
            modelId: getCurrentModelId() ?? undefined,
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
        // Dynamic-batch models go through the collector (batched session.run); static models keep the
        // direct path so their decode/preprocess still overlaps the run via queue concurrency.
        const imagePrediction =
          getBatchCap() > 1 ? await this.batchCollector.submit(task) : await processInferenceTask(task);
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
          batchSize: imagePrediction.processingTime.batchSize,
          detectionsCount: imagePrediction.predictions.length,
          cacheHit: false,
          backend: getInferenceBackend(),
          modelId: getCurrentModelId() ?? undefined,
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
          modelId: getCurrentModelId() ?? undefined,
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
      } else if (task.mediaMetadata.kind === 'gifFrame') {
        const gifFramePrediction = this.toGifFramePrediction(imagePrediction, task.mediaMetadata);
        this.sendGifFramePredictionsToContent([gifFramePrediction], task.hostname);
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

  private toGifFramePrediction(imagePrediction: IImagePrediction, gifMetadata: IGifFrameMetadata): IGifFramePrediction {
    return {
      sessionId: gifMetadata.sessionId,
      hostname: imagePrediction.hostname,
      src: gifMetadata.src,
      frameIndex: gifMetadata.frameIndex,
      frameCount: gifMetadata.frameCount,
      width: imagePrediction.width,
      height: imagePrediction.height,
      predictions: imagePrediction.predictions,
      maskTransform: imagePrediction.maskTransform,
      timestamp: imagePrediction.timestamp,
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

  private sendGifFramePredictionsToContent(predictions: IGifFramePrediction[], hostname: string): void {
    try {
      if (this.onGifFramePredictionsCallback) {
        this.onGifFramePredictionsCallback(predictions, hostname);
      }
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending GIF frame predictions:', error);
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
