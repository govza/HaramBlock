import { getCurrentModelId } from '@inference-runtime';

import { BatchCollector } from '@/entrypoints/background/services/batchCollector';
import { getBatchCap, getInferenceBackend, processInferenceBatch, processInferenceTask } from '@/utils/inference';
import { logger } from '@/utils/logger';
import { emitEvent } from '@/utils/logging';

import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { QueueService } from '@/entrypoints/background/services/queueService';
import type {
  FrameInferenceResult,
  GifFrameInferenceResult,
  IImagePrediction,
  IFramePrediction,
  IFrameMetadata,
  IGifFrameMetadata,
  IGifFramePrediction,
  IHostSettings,
  IMediaMetadata,
  ImageInferenceResult,
  InferenceTask,
} from '@/utils/types';

type OnImagePredictionsCallback = (results: ImageInferenceResult[], hostname: string) => void;
type OnFramePredictionsCallback = (results: FrameInferenceResult[], hostname: string) => void;
type OnGifFramePredictionsCallback = (results: GifFrameInferenceResult[], hostname: string) => void;

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
  /** At most one not-yet-started playback frame is retained per video session. */
  private queuedPlaybackFrames = new Map<string, { task: InferenceTask; controller: AbortController }>();

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
          this.sendImageResultsToContent(
            predictionsWithHostname.map(prediction => ({ status: 'ok' as const, prediction })),
            hostname,
          );

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

    let controller: AbortController | undefined;
    if (mediaMetadata.kind === 'frame' && mediaMetadata.frameIndex >= 0) {
      const previous = this.queuedPlaybackFrames.get(mediaMetadata.sessionId);
      if (previous) {
        // frameIndex is per-session monotonic, but arrival order is not (the
        // cancel RPC and frame payloads ride different transports): a frame
        // older than the queued one must be dropped, never replace it.
        const previousIndex =
          previous.task.mediaMetadata.kind === 'frame' ? previous.task.mediaMetadata.frameIndex : -1;
        if (previousIndex >= mediaMetadata.frameIndex) {
          task.bitmap?.close();
          return;
        }
        previous.controller.abort();
        previous.task.bitmap?.close();
      }
      controller = new AbortController();
      this.queuedPlaybackFrames.set(mediaMetadata.sessionId, { task, controller });
    }

    this.queueService.enqueue(task, controller?.signal).catch(error => {
      if (controller?.signal.aborted) return;
      logger.withTag('inferenceOrchestrationService').error(`Failed to enqueue task for ${imageSrc}:`, error);
      this.sendErrorToContent(task, error);
    });
  }

  private setupEventHandlers(): void {
    this.queueService.setTaskProcessingHandler(async (task: InferenceTask) => {
      this.markPlaybackFrameStarted(task);
      try {
        // Dynamic-batch models go through the collector (batched session.run); static models keep the
        // direct path so their decode/preprocess still overlaps the run via queue concurrency.
        const imagePrediction =
          getBatchCap() > 1 ? await this.batchCollector.submit(task) : await processInferenceTask(task);
        await this.handleSuccess(task, imagePrediction);

        // Video and GIF frames arrive at sample cadence (~4/s per video) and
        // would flood the 500-entry wide-event buffer image debugging relies on
        if (task.mediaMetadata.kind !== 'image') return;

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
        if (task.mediaMetadata.kind === 'image') {
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
        }
        logger.withTag('inferenceOrchestrationService').error(`Error processing image ${task.imageSrc}:`, error);
        this.sendErrorToContent(task, error);
      }
    });
  }

  /** Abort and release a playback frame that has not started inference yet. */
  cancelVideoSession(sessionId: string): void {
    const queued = this.queuedPlaybackFrames.get(sessionId);
    if (!queued) return;
    this.queuedPlaybackFrames.delete(sessionId);
    queued.controller.abort();
    queued.task.bitmap?.close();
  }

  private markPlaybackFrameStarted(task: InferenceTask): void {
    if (task.mediaMetadata.kind !== 'frame' || task.mediaMetadata.frameIndex < 0) return;
    const queued = this.queuedPlaybackFrames.get(task.mediaMetadata.sessionId);
    if (queued?.task === task) this.queuedPlaybackFrames.delete(task.mediaMetadata.sessionId);
  }

  private async handleSuccess(task: InferenceTask, imagePrediction: IImagePrediction): Promise<void> {
    try {
      if (task.mediaMetadata.kind === 'frame') {
        const framePrediction = this.toFramePrediction(imagePrediction, task.mediaMetadata);
        this.sendFrameResultsToContent([{ status: 'ok', prediction: framePrediction }], task.hostname);
      } else if (task.mediaMetadata.kind === 'gifFrame') {
        const gifFramePrediction = this.toGifFramePrediction(imagePrediction, task.mediaMetadata);
        this.sendGifFrameResultsToContent([{ status: 'ok', prediction: gifFramePrediction }], task.hostname);
      } else {
        // A cache write failure must not suppress the reply - the verdict is
        // already computed and content is waiting on it.
        try {
          await this.imageCacheService.cachePredictions([imagePrediction]);
        } catch (error) {
          logger
            .withTag('inferenceOrchestrationService')
            .warn(`Failed to cache prediction for ${task.imageSrc}:`, error);
        }
        this.sendImageResultsToContent([{ status: 'ok', prediction: imagePrediction }], task.hostname);
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
      timestampSec: frameMetadata.timestampSec,
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

  /**
   * Reply for failed inference so content reacts immediately instead of
   * waiting out its own timeout: images retry via their attempt counter,
   * video frames free the in-flight sample slot, GIF frames count toward the
   * session's failed-frame tally.
   */
  private sendErrorToContent(task: InferenceTask, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const { mediaMetadata } = task;
    if (mediaMetadata.kind === 'frame') {
      this.sendFrameResultsToContent(
        [
          {
            status: 'error',
            hostname: task.hostname,
            sessionId: mediaMetadata.sessionId,
            frameIndex: mediaMetadata.frameIndex,
            reason,
          },
        ],
        task.hostname,
      );
    } else if (mediaMetadata.kind === 'gifFrame') {
      this.sendGifFrameResultsToContent(
        [
          {
            status: 'error',
            hostname: task.hostname,
            src: mediaMetadata.src,
            sessionId: mediaMetadata.sessionId,
            reason,
          },
        ],
        task.hostname,
      );
    } else {
      this.sendImageResultsToContent(
        [{ status: 'error', src: task.imageSrc, hostname: task.hostname, reason }],
        task.hostname,
      );
    }
  }

  private sendImageResultsToContent(results: ImageInferenceResult[], hostname: string): void {
    try {
      if (this.onImagePredictionsCallback) {
        this.onImagePredictionsCallback(results, hostname);
      }
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending image inference results:', error);
    }
  }

  private sendFrameResultsToContent(results: FrameInferenceResult[], hostname: string): void {
    try {
      if (this.onFramePredictionsCallback) {
        this.onFramePredictionsCallback(results, hostname);
      }
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending frame inference results:', error);
    }
  }

  private sendGifFrameResultsToContent(results: GifFrameInferenceResult[], hostname: string): void {
    try {
      if (this.onGifFramePredictionsCallback) {
        this.onGifFramePredictionsCallback(results, hostname);
      }
    } catch (error) {
      logger.withTag('inferenceOrchestrationService').error('Error sending GIF frame inference results:', error);
    }
  }
}
