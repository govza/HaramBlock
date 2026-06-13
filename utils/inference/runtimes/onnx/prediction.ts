import { edgeBoundingBoxCorrection } from '@/entrypoints/background/modelUtils/corrections';
import { createCacheMetadataFromMediaMetadata } from '@/utils/cacheUtils';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { loadImageBitmap, preprocessImage } from '@/utils/inference/preprocessing';
import { getBackend, loadModel, ort, runSession } from '@/utils/inference/runtimes/onnx/modelLoader';
import { getPostprocessor, type TypedResults } from '@/utils/inference/runtimes/onnx/postprocessors';
import { logger } from '@/utils/logger';

import type { IElementPrediction, IImagePrediction, IMaskTransform, ModelMetadata } from '@/utils/types';
import type { InferenceTask } from '@/utils/types/model';

export async function processInferenceTask(task: InferenceTask): Promise<IImagePrediction> {
  try {
    // Calculate queue time immediately to avoid double-counting fetch/decode time
    const taskStartAt = Date.now();
    const queueTime = task.queueStartAt ? taskStartAt - task.queueStartAt : 0;

    const { session, config } = await loadModel();

    // Use provided bitmap/blob (from MessageChannel/structured clone) or fetch from URL
    let imageBitmap: ImageBitmap;
    let fetchTime = 0;
    let decodeTime = 0;
    let imageWidth: number;
    let imageHeight: number;

    if (task.bitmap) {
      // Use pre-loaded bitmap (zero-copy transfer from content script via MessageChannel)
      imageBitmap = task.bitmap;
      imageWidth = task.originalWidth || imageBitmap.width;
      imageHeight = task.originalHeight || imageBitmap.height;
      fetchTime = task.fetchTime ?? 0;
      decodeTime = task.decodeTime ?? 0;
    } else if (task.blob) {
      // Convert blob to bitmap (Firefox structured clone path)
      const decodeStartTime = Date.now();
      imageBitmap = await createImageBitmap(task.blob);
      decodeTime = Date.now() - decodeStartTime;
      imageWidth = task.originalWidth || imageBitmap.width;
      imageHeight = task.originalHeight || imageBitmap.height;
      fetchTime = task.fetchTime ?? 0;
    } else {
      // Fetch and decode image from URL (fallback path - background does all work)
      const loaded = await loadImageBitmap(task.imageSrc);
      ({ imageBitmap, fetchTime, decodeTime } = loaded);
      imageWidth = imageBitmap.width;
      imageHeight = imageBitmap.height;
    }

    const inferenceStartAt = Date.now();

    const rawThreshold = 1 - task.hostSettings.strictness;
    const scoreThreshold = Math.min(0.9, Math.max(0.05, rawThreshold));

    // Use try/finally to ensure bitmap cleanup even on inference errors
    let rawPredictions: IElementPrediction[];
    let bitmapWidth: number;
    let bitmapHeight: number;
    try {
      rawPredictions = await getFramePredictions(imageBitmap, session, config, scoreThreshold, imageWidth, imageHeight);
      bitmapWidth = imageBitmap.width;
      bitmapHeight = imageBitmap.height;
    } finally {
      // Release GPU memory - ImageBitmap is no longer needed after inference
      imageBitmap.close();
    }

    const inferenceEndAt = Date.now();
    const inferenceTime = inferenceEndAt - inferenceStartAt;

    // Calculate E2E time: from content script request start to inference completion
    const e2eTime = task.requestStartAt ? inferenceEndAt - task.requestStartAt : 0;

    const predictions = edgeBoundingBoxCorrection(rawPredictions, bitmapWidth, bitmapHeight);

    const timestamp = Date.now();

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

    const result: IImagePrediction = {
      hostname: getEffectiveHostname(task.hostname),
      src: task.imageSrc,
      width: imageWidth,
      height: imageHeight,
      predictions,
      timestamp,
      cacheMetadata,
      maskTransform,
      processingTime: {
        fetchTime,
        decodeTime,
        queueTime,
        inferenceTime,
        e2eTime,
        backend: getBackend(),
      },
      forcedVisibility: 'auto',
    };

    return result;
  } catch (error) {
    logger.withTag('prediction').error(`Failed to process image task for ${task.imageSrc}:`, error);
    throw new Error(`Failed to process image task for ${task.imageSrc}`, { cause: error });
  }
}

async function getFramePredictions(
  imageBitmap: ImageBitmap,
  session: ort.InferenceSession,
  config: ModelMetadata,
  scoreThreshold: number,
  originalWidth: number,
  originalHeight: number,
): Promise<IElementPrediction[]> {
  const [modelHeight, modelWidth] = config.imgsz;

  try {
    const preprocessT0 = performance.now();
    const tensorData = preprocessImage(imageBitmap, config);
    const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, modelHeight, modelWidth]);
    const preprocessTime = performance.now() - preprocessT0;

    const feeds: Record<string, typeof inputTensor> = { [config.inputName]: inputTensor };
    const runT0 = performance.now();
    const results = await runSession(session, feeds);
    const sessionRunTime = performance.now() - runT0;

    const postprocessT0 = performance.now();
    const typedResults = results as TypedResults;
    const predictions = getPostprocessor(config.task)({
      results: typedResults,
      config,
      scoreThreshold,
      originalWidth,
      originalHeight,
    });
    const postprocessTime = performance.now() - postprocessT0;

    inputTensor.dispose();
    for (const key of Object.keys(results)) {
      results[key]?.dispose();
    }

    if (import.meta.env.DEV) {
      logger
        .withTag('profiler')
        .info(
          `preprocess: ${preprocessTime.toFixed(1)}ms | session.run: ${sessionRunTime.toFixed(1)}ms | postprocess: ${postprocessTime.toFixed(1)}ms`,
        );
    }

    return predictions;
  } catch (error) {
    logger.withTag('prediction').error('Error in getFramePredictions:', error);
    throw error;
  }
}
