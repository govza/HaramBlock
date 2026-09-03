import { SpanStatusCode, type Counter, type Histogram, type Span } from '@opentelemetry/api';

import { getCurrentModelId } from '@inference-runtime';

import { BatchCollector } from '@/entrypoints/background/services/batchCollector';
import { getBatchCap, getInferenceBackend, processInferenceBatch, processInferenceTask } from '@/utils/inference';
import {
  ATTR,
  extractTraceparent,
  getLogger,
  getMeter,
  getTracer,
  injectTraceparent,
  requestIdFor,
} from '@/utils/telemetry';
import { SPAN } from '@/utils/telemetry/roundtrip';

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
  traceparent?: string;
};

const log = getLogger('inferenceOrchestrationService');
const tracer = getTracer('inference');

interface InferenceInstruments {
  runDurationMs: Histogram;
  requestCounter: Counter;
}

let instruments: InferenceInstruments | null = null;

function getInstruments(): InferenceInstruments {
  if (instruments) return instruments;
  const meter = getMeter('inference');
  instruments = {
    runDurationMs: meter.createHistogram('hb.inference.run.duration', {
      unit: 'ms',
      description: 'Wall time of one inference task from dequeue to prediction',
    }),
    requestCounter: meter.createCounter('hb.inference.requests', {
      description: 'Inference requests by media kind and outcome',
    }),
  };
  return instruments;
}

type TaskIdentity = Pick<InferenceTask, 'imageSrc' | 'hostname' | 'mediaMetadata'>;

function mediaKindOf(mediaMetadata: IMediaMetadata): 'image' | 'frame' | 'gif' {
  if (mediaMetadata.kind === 'frame') return 'frame';
  if (mediaMetadata.kind === 'gifFrame') return 'gif';
  return 'image';
}

function taskAttributes({ imageSrc, hostname, mediaMetadata }: TaskIdentity): Record<string, string | number> {
  const base = {
    [ATTR.mediaKind]: mediaKindOf(mediaMetadata),
    [ATTR.hostname]: hostname,
    [ATTR.src]: imageSrc,
    [ATTR.reqId]: requestIdFor(imageSrc),
  };
  if (mediaMetadata.kind === 'image') return base;
  return { ...base, [ATTR.sessionId]: mediaMetadata.sessionId, [ATTR.frameIndex]: mediaMetadata.frameIndex };
}

function modelAttributes(): Record<string, string> {
  return { [ATTR.backend]: getInferenceBackend(), [ATTR.modelId]: getCurrentModelId() ?? 'unknown' };
}

export class InferenceOrchestrationService {
  private onImagePredictionsCallback?: OnImagePredictionsCallback;
  private onFramePredictionsCallback?: OnFramePredictionsCallback;
  private onGifFramePredictionsCallback?: OnGifFramePredictionsCallback;
  /** At most one not-yet-started playback frame is retained per video session. */
  private queuedPlaybackFrames = new Map<string, { task: InferenceTask; controller: AbortController }>();
  private queueWaitSpans = new WeakMap<InferenceTask, Span>();

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
    const { traceparent } = args;
    const traceContext = extractTraceparent(traceparent);
    const attributes = taskAttributes({ imageSrc, hostname, mediaMetadata });

    // Only check cache for images, not video frames
    if (mediaMetadata.kind === 'image') {
      const cacheSpan = tracer.startSpan(SPAN.cache, { attributes }, traceContext);
      try {
        const cachedPredictions = await this.imageCacheService.getCachedPredictionsBySrc(imageSrc);

        if (cachedPredictions && cachedPredictions.length > 0) {
          const predictionsWithHostname = cachedPredictions.map(prediction => ({
            ...prediction,
            hostname,
          }));
          await this.imageCacheService.cachePredictions(predictionsWithHostname);
          this.sendImageResultsToContent(
            predictionsWithHostname.map(prediction => ({ status: 'ok' as const, prediction, traceparent })),
            hostname,
          );
          const detectionsCount = cachedPredictions.reduce((sum, p) => sum + p.predictions.length, 0);
          cacheSpan.setAttributes({ [ATTR.cacheHit]: true, [ATTR.detectionsCount]: detectionsCount });
          cacheSpan.end();
          getInstruments().requestCounter.add(1, { [ATTR.mediaKind]: 'image', [ATTR.status]: 'cached' });
          log.debug('inference.cache.hit', { ...attributes, [ATTR.detectionsCount]: detectionsCount }, traceContext);
          return;
        }
        cacheSpan.setAttribute(ATTR.cacheHit, false);
        cacheSpan.end();
      } catch (error) {
        cacheSpan.setStatus({ code: SpanStatusCode.ERROR });
        cacheSpan.end();
        log.warn('inference.cache.lookup.failed', { ...attributes, error }, traceContext);
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
      traceContext,
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
          log.debug('inference.frame.dropped', { ...attributes, reason: 'older than queued' }, traceContext);
          return;
        }
        previous.controller.abort();
        previous.task.bitmap?.close();
        this.endQueueWait(previous.task, 'superseded');
      }
      controller = new AbortController();
      this.queuedPlaybackFrames.set(mediaMetadata.sessionId, { task, controller });
    }

    this.queueWaitSpans.set(
      task,
      tracer.startSpan(SPAN.queueWait, { attributes: { ...attributes, [ATTR.priority]: args.priority } }, traceContext),
    );
    this.queueService.enqueue(task, controller?.signal).catch(error => {
      if (controller?.signal.aborted) {
        this.endQueueWait(task, 'aborted');
        return;
      }
      this.endQueueWait(task, 'error');
      log.error('inference.enqueue.failed', { ...attributes, error }, traceContext);
      this.sendErrorToContent(task, error);
    });
  }

  private endQueueWait(task: InferenceTask, outcome: 'started' | 'aborted' | 'superseded' | 'error'): void {
    const span = this.queueWaitSpans.get(task);
    if (!span) return;
    this.queueWaitSpans.delete(task);
    span.setAttribute(ATTR.status, outcome);
    span.end();
  }

  private setupEventHandlers(): void {
    this.queueService.setTaskProcessingHandler(async (task: InferenceTask) => {
      this.markPlaybackFrameStarted(task);
      this.endQueueWait(task, 'started');
      const attributes = taskAttributes(task);
      const runSpan = tracer.startSpan(SPAN.run, { attributes }, task.traceContext);
      const runStartedAt = Date.now();
      try {
        // Dynamic-batch models go through the collector (batched session.run); static models keep the
        // direct path so their decode/preprocess still overlaps the run via queue concurrency.
        const imagePrediction =
          getBatchCap() > 1 ? await this.batchCollector.submit(task) : await processInferenceTask(task);
        this.recordRun(runSpan, task, imagePrediction, runStartedAt);
        await this.handleSuccess(task, imagePrediction);
      } catch (error) {
        runSpan.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : undefined });
        runSpan.setAttributes({ ...modelAttributes(), [ATTR.status]: 'error' });
        runSpan.end();
        getInstruments().runDurationMs.record(Date.now() - runStartedAt, {
          [ATTR.mediaKind]: attributes[ATTR.mediaKind],
          [ATTR.status]: 'error',
        });
        getInstruments().requestCounter.add(1, {
          [ATTR.mediaKind]: attributes[ATTR.mediaKind],
          [ATTR.status]: 'error',
        });
        log.error('inference.run.failed', { ...attributes, error }, task.traceContext);
        this.sendErrorToContent(task, error);
      }
    });
  }

  private recordRun(runSpan: Span, task: InferenceTask, prediction: IImagePrediction, runStartedAt: number): void {
    const { processingTime } = prediction;
    const mediaKind = mediaKindOf(task.mediaMetadata);
    const timing = {
      [ATTR.fetchMs]: processingTime.fetchTime,
      [ATTR.decodeMs]: processingTime.decodeTime,
      [ATTR.queueMs]: processingTime.queueTime,
      [ATTR.inferenceMs]: processingTime.inferenceTime,
      [ATTR.e2eMs]: processingTime.e2eTime,
      [ATTR.batchSize]: processingTime.batchSize ?? 1,
      [ATTR.detectionsCount]: prediction.predictions.length,
      [ATTR.status]: 'success',
      ...modelAttributes(),
    };
    runSpan.setAttributes(timing);
    runSpan.setStatus({ code: SpanStatusCode.OK });
    runSpan.end();
    getInstruments().runDurationMs.record(Date.now() - runStartedAt, {
      [ATTR.mediaKind]: mediaKind,
      [ATTR.status]: 'success',
    });
    getInstruments().requestCounter.add(1, { [ATTR.mediaKind]: mediaKind, [ATTR.status]: 'success' });
    if (task.mediaMetadata.kind === 'image') {
      log.info(
        'inference.run.completed',
        { [ATTR.src]: task.imageSrc, [ATTR.hostname]: task.hostname, ...timing },
        task.traceContext,
      );
    }
  }

  /** Abort and release a playback frame that has not started inference yet. */
  cancelVideoSession(sessionId: string): void {
    const queued = this.queuedPlaybackFrames.get(sessionId);
    if (!queued) return;
    this.queuedPlaybackFrames.delete(sessionId);
    queued.controller.abort();
    queued.task.bitmap?.close();
    this.endQueueWait(queued.task, 'aborted');
  }

  private markPlaybackFrameStarted(task: InferenceTask): void {
    if (task.mediaMetadata.kind !== 'frame' || task.mediaMetadata.frameIndex < 0) return;
    const queued = this.queuedPlaybackFrames.get(task.mediaMetadata.sessionId);
    if (queued?.task === task) this.queuedPlaybackFrames.delete(task.mediaMetadata.sessionId);
  }

  private async handleSuccess(task: InferenceTask, imagePrediction: IImagePrediction): Promise<void> {
    const traceparent = injectTraceparent(task.traceContext);
    try {
      if (task.mediaMetadata.kind === 'frame') {
        const framePrediction = this.toFramePrediction(imagePrediction, task.mediaMetadata);
        this.sendFrameResultsToContent([{ status: 'ok', prediction: framePrediction, traceparent }], task.hostname);
      } else if (task.mediaMetadata.kind === 'gifFrame') {
        const gifFramePrediction = this.toGifFramePrediction(imagePrediction, task.mediaMetadata);
        this.sendGifFrameResultsToContent(
          [{ status: 'ok', prediction: gifFramePrediction, traceparent }],
          task.hostname,
        );
      } else {
        // A cache write failure must not suppress the reply - the verdict is
        // already computed and content is waiting on it.
        try {
          await this.imageCacheService.cachePredictions([imagePrediction]);
        } catch (error) {
          log.warn('inference.cache.write.failed', { [ATTR.src]: task.imageSrc, error }, task.traceContext);
        }
        this.sendImageResultsToContent([{ status: 'ok', prediction: imagePrediction, traceparent }], task.hostname);
      }
    } catch (error) {
      log.error('inference.result.dispatch.failed', { [ATTR.src]: task.imageSrc, error }, task.traceContext);
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
    const traceparent = injectTraceparent(task.traceContext);
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
            traceparent,
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
            traceparent,
          },
        ],
        task.hostname,
      );
    } else {
      this.sendImageResultsToContent(
        [{ status: 'error', src: task.imageSrc, hostname: task.hostname, reason, traceparent }],
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
      log.error('inference.result.emit.failed', { [ATTR.hostname]: hostname, [ATTR.mediaKind]: 'image', error });
    }
  }

  private sendFrameResultsToContent(results: FrameInferenceResult[], hostname: string): void {
    try {
      if (this.onFramePredictionsCallback) {
        this.onFramePredictionsCallback(results, hostname);
      }
    } catch (error) {
      log.error('inference.result.emit.failed', { [ATTR.hostname]: hostname, [ATTR.mediaKind]: 'frame', error });
    }
  }

  private sendGifFrameResultsToContent(results: GifFrameInferenceResult[], hostname: string): void {
    try {
      if (this.onGifFramePredictionsCallback) {
        this.onGifFramePredictionsCallback(results, hostname);
      }
    } catch (error) {
      log.error('inference.result.emit.failed', { [ATTR.hostname]: hostname, [ATTR.mediaKind]: 'gif', error });
    }
  }
}
