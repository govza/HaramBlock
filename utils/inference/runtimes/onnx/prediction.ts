import { edgeBoundingBoxCorrection } from '@/entrypoints/background/modelUtils/corrections';
import { strictnessToScoreThreshold } from '@/entrypoints/background/modelUtils/scoreThreshold';
import { createCacheMetadataFromMediaMetadata } from '@/utils/cacheUtils';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { loadImageBitmap, preprocessImage } from '@/utils/inference/preprocessing';
import { acquireModelRuntime, getBackend, ort, runSession } from '@/utils/inference/runtimes/onnx/modelLoader';
import { getPostprocessor, type TypedResults } from '@/utils/inference/runtimes/onnx/postprocessors';
import { logger } from '@/utils/logger';

import type { IImagePrediction, IMaskTransform, IElementPrediction } from '@/utils/types';
import type { InferenceTask } from '@/utils/types/model';

/** One slot of a batched run: either a prediction or the error that isolated this image. */
export interface BatchItemResult {
  result?: IImagePrediction;
  error?: Error;
}

interface PreparedImage {
  task: InferenceTask;
  bitmap: ImageBitmap;
  imageWidth: number;
  imageHeight: number;
  bitmapWidth: number;
  bitmapHeight: number;
  fetchTime: number;
  decodeTime: number;
  queueTime: number;
}

function scoreThresholdFor(task: InferenceTask): number {
  return strictnessToScoreThreshold(task.hostSettings.strictness);
}

interface ResolvedBitmap {
  bitmap: ImageBitmap;
  imageWidth: number;
  imageHeight: number;
  fetchTime: number;
  decodeTime: number;
}

// Mirrors processInferenceTask's old bitmap sources: MessageChannel transferable, Firefox
// structured-clone blob, or a URL fetch fallback.
async function resolveBitmap(task: InferenceTask): Promise<ResolvedBitmap> {
  if (task.bitmap) {
    return {
      bitmap: task.bitmap,
      imageWidth: task.originalWidth || task.bitmap.width,
      imageHeight: task.originalHeight || task.bitmap.height,
      fetchTime: task.fetchTime ?? 0,
      decodeTime: task.decodeTime ?? 0,
    };
  }

  if (task.blob) {
    const decodeStartTime = Date.now();
    const bitmap = await createImageBitmap(task.blob);
    return {
      bitmap,
      imageWidth: task.originalWidth || bitmap.width,
      imageHeight: task.originalHeight || bitmap.height,
      fetchTime: task.fetchTime ?? 0,
      decodeTime: Date.now() - decodeStartTime,
    };
  }

  const loaded = await loadImageBitmap(task.imageSrc);
  return {
    bitmap: loaded.imageBitmap,
    imageWidth: loaded.imageBitmap.width,
    imageHeight: loaded.imageBitmap.height,
    fetchTime: loaded.fetchTime,
    decodeTime: loaded.decodeTime,
  };
}

async function prepareImage(task: InferenceTask): Promise<PreparedImage> {
  const queueTime = task.queueStartAt ? Date.now() - task.queueStartAt : 0;
  const resolved = await resolveBitmap(task);
  return {
    task,
    ...resolved,
    bitmapWidth: resolved.bitmap.width,
    bitmapHeight: resolved.bitmap.height,
    queueTime,
  };
}

// Carve image `index` out of a batched output, returning a [1, ...] view per tensor so the existing
// single-image postprocessors work unchanged. Float32Array.subarray is a zero-copy view, so the
// postprocessor's `c * spatial + ...` indexing lands inside this image's block.
function sliceBatchOutputs(outputs: TypedResults, index: number, batchSize: number): TypedResults {
  if (batchSize === 1) return outputs;

  const sliced: TypedResults = {};
  for (const key of Object.keys(outputs)) {
    const tensor = outputs[key];
    if (!tensor) continue;
    const perItem = tensor.dims.slice(1).reduce((a, b) => a * b, 1);
    const data = tensor.data as Float32Array;
    sliced[key] = {
      data: data.subarray(index * perItem, (index + 1) * perItem),
      dims: [1, ...tensor.dims.slice(1)],
    };
  }
  return sliced;
}

function buildImagePrediction(
  prepared: PreparedImage,
  rawPredictions: IElementPrediction[],
  backend: string,
  inferenceTime: number,
  inferenceEndAt: number,
  batchSize: number,
): IImagePrediction {
  const { task, imageWidth, imageHeight, bitmapWidth, bitmapHeight, fetchTime, decodeTime, queueTime } = prepared;

  const predictions = edgeBoundingBoxCorrection(rawPredictions, bitmapWidth, bitmapHeight);
  const e2eTime = task.requestStartAt ? inferenceEndAt - task.requestStartAt : 0;
  const cacheMetadata = createCacheMetadataFromMediaMetadata(task.mediaMetadata);

  // Derive mask transform from actual mask dimensions in predictions.
  // The mask is already cropped (no letterbox padding), so it maps directly to the original image.
  const firstMask = predictions.find(p => p.masks && p.masks.runs.length > 0)?.masks;
  const maskW = firstMask?.width ?? 1;
  const maskH = firstMask?.height ?? 1;

  const maskTransform: IMaskTransform = {
    scaleX: imageWidth / maskW,
    scaleY: imageHeight / maskH,
    offsetX: 0,
    offsetY: 0,
  };

  return {
    hostname: getEffectiveHostname(task.hostname),
    src: task.imageSrc,
    width: imageWidth,
    height: imageHeight,
    predictions,
    timestamp: Date.now(),
    cacheMetadata,
    maskTransform,
    processingTime: {
      fetchTime,
      decodeTime,
      queueTime,
      inferenceTime,
      e2eTime,
      backend,
      batchSize,
    },
    forcedVisibility: 'auto',
  };
}

/**
 * Run inference for one or more tasks as a single batched session.run.
 * Per-image decode and postprocess failures are isolated: the returned array is aligned to `tasks`,
 * each slot carrying a prediction or that image's error, so one bad image never fails the batch. A
 * failure in the shared preprocess or GPU run still fails the whole batch.
 */
export async function processInferenceBatch(tasks: InferenceTask[]): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = new Array<BatchItemResult>(tasks.length);

  // Decode all images up front (independent, so in parallel); failures drop out of the GPU batch.
  const prepared = await Promise.all(
    tasks.map(async (task, index): Promise<{ index: number; image: PreparedImage | null }> => {
      try {
        return { index, image: await prepareImage(task) };
      } catch (error) {
        logger.withTag('prediction').error(`Failed to prepare image for ${task.imageSrc}:`, error);
        results[index] = { error: error instanceof Error ? error : new Error(String(error)) };
        return { index, image: null };
      }
    }),
  );

  const ready = prepared.filter((p): p is { index: number; image: PreparedImage } => p.image !== null);
  if (ready.length === 0) return results;

  const inferenceStartAt = Date.now();
  let backend = getBackend();

  try {
    const runtime = await acquireModelRuntime();
    ({ backend } = runtime);
    try {
      const { session, config } = runtime;
      const [modelHeight, modelWidth] = config.imgsz;
      const perImageLen = 3 * modelHeight * modelWidth;

      const batchData = new Float32Array(ready.length * perImageLen);
      ready.forEach((item, i) => {
        batchData.set(preprocessImage(item.image.bitmap, config), i * perImageLen);
      });

      const inputTensor = new ort.Tensor('float32', batchData, [ready.length, 3, modelHeight, modelWidth]);
      const feeds: Record<string, typeof inputTensor> = { [config.inputName]: inputTensor };

      const runT0 = performance.now();
      const rawOutputs = await runSession(session, feeds);
      const runTime = performance.now() - runT0;

      const inferenceEndAt = Date.now();
      // Amortize the batch's wall time across its images. Attributing the whole-batch time to each
      // image would make the per-image inferenceTime (and the throughput derived from it in
      // PerformanceStats) undercount by the batch size.
      const perImageInferenceTime = (inferenceEndAt - inferenceStartAt) / ready.length;
      const typedOutputs = rawOutputs as TypedResults;
      const postprocess = getPostprocessor(config.task);

      ready.forEach((item, i) => {
        try {
          const rawPredictions = postprocess({
            results: sliceBatchOutputs(typedOutputs, i, ready.length),
            config,
            scoreThreshold: scoreThresholdFor(item.image.task),
            originalWidth: item.image.imageWidth,
            originalHeight: item.image.imageHeight,
          });
          results[item.index] = {
            result: buildImagePrediction(
              item.image,
              rawPredictions,
              backend,
              perImageInferenceTime,
              inferenceEndAt,
              ready.length,
            ),
          };
        } catch (error) {
          logger.withTag('prediction').error(`Postprocess failed for ${item.image.task.imageSrc}:`, error);
          results[item.index] = { error: error instanceof Error ? error : new Error(String(error)) };
        }
      });

      inputTensor.dispose();
      for (const key of Object.keys(rawOutputs)) {
        rawOutputs[key]?.dispose();
      }

      if (import.meta.env.DEV) {
        logger
          .withTag('profiler')
          .info(
            `batch=${ready.length} session.run: ${runTime.toFixed(1)}ms (${(runTime / ready.length).toFixed(1)}ms/img)`,
          );
      }
    } finally {
      runtime.release();
    }
  } catch (error) {
    logger.withTag('prediction').error('Batched inference failed:', error);
    const err = error instanceof Error ? error : new Error(String(error));
    ready.forEach(item => {
      results[item.index] ??= { error: err };
    });
  } finally {
    // Release GPU memory - ImageBitmaps are no longer needed after inference.
    ready.forEach(item => item.image.bitmap.close());
  }

  return results;
}

export async function processInferenceTask(task: InferenceTask): Promise<IImagePrediction> {
  const [item] = await processInferenceBatch([task]);
  if (!item || item.error) {
    throw new Error(`Failed to process image task for ${task.imageSrc}`, { cause: item?.error });
  }
  return item.result as IImagePrediction;
}
