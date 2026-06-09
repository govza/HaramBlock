import { edgeBoundingBoxCorrection } from '@/entrypoints/background/modelUtils/corrections';
import { calculateLetterboxParams, calculateScaleFactors } from '@/entrypoints/background/modelUtils/maskTransform';
import { createCacheMetadataFromMediaMetadata } from '@/utils/cacheUtils';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { loadImageBitmap, preprocessImage } from '@/utils/inference/preprocessing';
import { getBackend, loadModel, ort } from '@/utils/inference/runtimes/onnx/modelLoader';
import { logger } from '@/utils/logger';
import { encodeMaskRLE } from '@/utils/rle';

import type { IElementPrediction, IImagePrediction, IMaskTransform, ModelMetadata } from '@/utils/types';
import type { InferenceTask } from '@/utils/types/model';

let maskBuffer: Uint8Array | null = null;

function getMaskBuffer(size: number): Uint8Array {
  if (!maskBuffer || maskBuffer.length < size) {
    maskBuffer = new Uint8Array(size);
  }
  return maskBuffer;
}

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
    const results = await session.run(feeds);
    const sessionRunTime = performance.now() - runT0;

    const postprocessT0 = performance.now();
    const typedResults = results as Record<string, { data: ArrayLike<number>; dims: readonly number[] }>;

    let predictions: IElementPrediction[];

    if (config.task === 'semantic') {
      const semanticOutput = typedResults['output0'];
      const outDims = semanticOutput?.dims;
      const outH = (outDims?.[2] as number) ?? config.outputShape[0];
      const outW = (outDims?.[3] as number) ?? config.outputShape[1];

      const letterboxParams = calculateLetterboxParams(
        originalWidth,
        originalHeight,
        modelWidth,
        modelHeight,
        outW,
        outH,
      );
      const { scaleX, scaleY, offsetX, offsetY } = calculateScaleFactors(
        originalWidth,
        originalHeight,
        modelWidth,
        modelHeight,
      );

      predictions = processSemanticSegmentation(
        typedResults,
        config,
        scoreThreshold,
        modelWidth,
        modelHeight,
        scaleX,
        scaleY,
        offsetX,
        offsetY,
        letterboxParams,
      );
    } else {
      const masksOutput = results[config.outputNames.masks];
      const protoDims = masksOutput?.dims as number[] | undefined;
      const protoHeight = protoDims?.[2] ?? config.outputShape[0];
      const protoWidth = protoDims?.[3] ?? config.outputShape[1];

      const letterboxParams = calculateLetterboxParams(
        originalWidth,
        originalHeight,
        modelWidth,
        modelHeight,
        protoWidth,
        protoHeight,
      );
      const { scaleX, scaleY, offsetX, offsetY } = calculateScaleFactors(
        originalWidth,
        originalHeight,
        modelWidth,
        modelHeight,
      );

      predictions = processInstanceSegmentation(
        typedResults,
        config,
        scoreThreshold,
        modelWidth,
        modelHeight,
        scaleX,
        scaleY,
        offsetX,
        offsetY,
        letterboxParams,
      );
    }

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

/**
 * Process semantic segmentation output.
 * Output: [batch, num_classes, H, W] - per-pixel class logits.
 * Creates one prediction per target class found, with a full-resolution mask.
 */
function processSemanticSegmentation(
  results: Record<string, { data: ArrayLike<number>; dims: readonly number[] }>,
  config: ModelMetadata,
  scoreThreshold: number,
  modelWidth: number,
  modelHeight: number,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number,
  letterboxParams: ReturnType<typeof calculateLetterboxParams>,
): IElementPrediction[] {
  const output = results['output0'];
  if (!output) {
    logger.withTag('prediction').error(`Missing 'output0' tensor. Available: ${Object.keys(results).join(', ')}`);
    return [];
  }

  const data = output.data as Float32Array;
  const dims = output.dims as number[];
  const numClasses = dims[1] ?? 0;
  const outH = dims[2] ?? 0;
  const outW = dims[3] ?? 0;
  const spatial = outH * outW;

  // Build target class index map
  const targetClassIndices: Set<number> = new Set();
  for (const targetName of config.namesToCheck) {
    const entry = Object.entries(config.names).find(([, name]) => name === targetName);
    if (entry) targetClassIndices.add(Number(entry[0]));
  }

  // Letterbox crop bounds in output space
  const { protoOffsetX, protoOffsetY } = letterboxParams;
  const cropLeft = Math.round(protoOffsetX - 0.1);
  const cropTop = Math.round(protoOffsetY - 0.1);
  const cropRight = Math.round(outW - protoOffsetX + 0.1);
  const cropBottom = Math.round(outH - protoOffsetY + 0.1);
  const croppedWidth = cropRight - cropLeft;
  const croppedHeight = cropBottom - cropTop;

  // Subsample to match YOLO prototype resolution (model_size / 4) for blocky mask edges
  const step = Math.max(1, Math.round((outW * 4) / modelWidth));
  const subW = Math.ceil(croppedWidth / step);
  const subH = Math.ceil(croppedHeight / step);

  interface ClassAccumulator {
    mask: Uint8Array;
    confSum: number;
    pixelCount: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  const classData = new Map<number, ClassAccumulator>();
  for (const classId of targetClassIndices) {
    classData.set(classId, {
      mask: new Uint8Array(subW * subH),
      confSum: 0,
      pixelCount: 0,
      minX: subW,
      minY: subH,
      maxX: 0,
      maxY: 0,
    });
  }

  let bufferIdx = 0;
  for (let sy = 0; sy < subH; sy++) {
    const y = Math.min(cropTop + sy * step, cropBottom - 1);
    for (let sx = 0; sx < subW; sx++) {
      const x = Math.min(cropLeft + sx * step, cropRight - 1);

      let maxLogit = -Infinity;
      let maxClass = 0;
      for (let c = 0; c < numClasses; c++) {
        const logit = data[c * spatial + y * outW + x] ?? 0;
        if (logit > maxLogit) {
          maxLogit = logit;
          maxClass = c;
        }
      }

      const acc = classData.get(maxClass);
      if (acc) {
        let expSum = 0;
        for (let c = 0; c < numClasses; c++) {
          expSum += Math.exp((data[c * spatial + y * outW + x] ?? 0) - maxLogit);
        }
        const prob = 1 / expSum;

        if (prob >= scoreThreshold) {
          acc.mask[bufferIdx] = 1;
          acc.confSum += prob;
          acc.pixelCount++;

          if (sx < acc.minX) acc.minX = sx;
          if (sy < acc.minY) acc.minY = sy;
          if (sx > acc.maxX) acc.maxX = sx;
          if (sy > acc.maxY) acc.maxY = sy;
        }
      }

      bufferIdx++;
    }
  }

  const predictions: IElementPrediction[] = [];

  const contentWidth = modelWidth - 2 * offsetX;
  const contentHeight = modelHeight - 2 * offsetY;
  const pixelScaleX = contentWidth / croppedWidth;
  const pixelScaleY = contentHeight / croppedHeight;

  for (const classId of targetClassIndices) {
    const acc = classData.get(classId);
    if (!acc || acc.pixelCount === 0) continue;

    const meanConf = acc.confSum / acc.pixelCount;
    const className = config.names[classId] ?? `class_${classId}`;

    const boxX1 = acc.minX * step * pixelScaleX * scaleX;
    const boxY1 = acc.minY * step * pixelScaleY * scaleY;
    const boxX2 = (acc.maxX + 1) * step * pixelScaleX * scaleX;
    const boxY2 = (acc.maxY + 1) * step * pixelScaleY * scaleY;

    predictions.push({
      classId,
      className,
      probability: meanConf,
      boundingBox: {
        x: Math.floor(boxX1),
        y: Math.floor(boxY1),
        width: Math.round(boxX2 - boxX1),
        height: Math.round(boxY2 - boxY1),
      },
      masks: encodeMaskRLE(acc.mask, subW, subH),
    });
  }

  return predictions;
}

/**
 * Process YOLO instance segmentation output.
 *
 * Expected output format (with nms=True):
 * - detections: [batch, num_dets, 38] = [x1, y1, x2, y2, conf, cls, mask_coeffs(32)]
 * - masks: [batch, 32, mask_h, mask_w] = prototype masks
 *
 * The final instance mask = sigmoid(mask_coeffs @ prototypes)
 * Masks are cropped to remove letterbox padding before encoding.
 */
function processInstanceSegmentation(
  results: Record<string, { data: ArrayLike<number>; dims: readonly number[] }>,
  config: ModelMetadata,
  scoreThreshold: number,
  modelWidth: number,
  modelHeight: number,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number,
  letterboxParams: ReturnType<typeof calculateLetterboxParams>,
): IElementPrediction[] {
  const predictions: IElementPrediction[] = [];

  const { detections: detectionsName, masks: masksName } = config.outputNames;
  const detectionsOutput = results[detectionsName];
  const masksOutput = results[masksName];

  if (!detectionsOutput) {
    logger
      .withTag('prediction')
      .error(`Missing '${detectionsName}' tensor. Available: ${Object.keys(results).join(', ')}`);
    return predictions;
  }

  const detections = detectionsOutput.data as Float32Array;
  const detsDims = detectionsOutput.dims as number[];

  const numDetections = detsDims[1] ?? 0;
  const numFeatures = detsDims[2] ?? 0;

  const hasMaskCoeffs = numFeatures >= 38;
  const numMaskCoeffs = hasMaskCoeffs ? 32 : 0;

  let prototypes: Float32Array | undefined;
  let protoHeight = 0;
  let protoWidth = 0;
  if (masksOutput && hasMaskCoeffs) {
    prototypes = masksOutput.data as Float32Array;
    const protoDims = masksOutput.dims as number[];
    protoHeight = protoDims[2] ?? 0;
    protoWidth = protoDims[3] ?? 0;
  }

  const targetClassIndices: Set<number> = new Set();
  for (const targetName of config.namesToCheck) {
    const entry = Object.entries(config.names).find(([, name]) => name === targetName);
    if (entry) {
      targetClassIndices.add(Number(entry[0]));
    }
  }

  for (let i = 0; i < numDetections; i++) {
    const baseIdx = i * numFeatures;

    const x1 = detections[baseIdx] ?? 0;
    const y1 = detections[baseIdx + 1] ?? 0;
    const x2 = detections[baseIdx + 2] ?? 0;
    const y2 = detections[baseIdx + 3] ?? 0;
    const confidence = detections[baseIdx + 4] ?? 0;
    const classId = Math.round(detections[baseIdx + 5] ?? 0);

    if (confidence < scoreThreshold || !targetClassIndices.has(classId)) {
      continue;
    }

    const className = config.names[classId] ?? `class_${classId}`;

    const modelX1 = x1 - offsetX;
    const modelY1 = y1 - offsetY;
    const modelX2 = x2 - offsetX;
    const modelY2 = y2 - offsetY;

    const contentWidth = modelWidth - 2 * offsetX;
    const contentHeight = modelHeight - 2 * offsetY;
    if (modelX2 < 0 || modelY2 < 0 || modelX1 > contentWidth || modelY1 > contentHeight) {
      continue;
    }

    const clampedX1 = Math.max(0, modelX1);
    const clampedY1 = Math.max(0, modelY1);
    const clampedX2 = Math.min(contentWidth, modelX2);
    const clampedY2 = Math.min(contentHeight, modelY2);

    let encodedMask;
    if (prototypes && hasMaskCoeffs && protoHeight > 0 && protoWidth > 0) {
      const coeffs: number[] = [];
      for (let c = 0; c < numMaskCoeffs; c++) {
        coeffs.push(detections[baseIdx + 6 + c] ?? 0);
      }

      const { protoOffsetX, protoOffsetY } = letterboxParams;

      const cropLeft = Math.round(protoOffsetX - 0.1);
      const cropTop = Math.round(protoOffsetY - 0.1);
      const cropRight = Math.round(protoWidth - protoOffsetX + 0.1);
      const cropBottom = Math.round(protoHeight - protoOffsetY + 0.1);

      const croppedWidth = cropRight - cropLeft;
      const croppedHeight = cropBottom - cropTop;
      const buffer = getMaskBuffer(croppedWidth * croppedHeight);

      let bufferIdx = 0;
      for (let y = cropTop; y < cropBottom; y++) {
        for (let x = cropLeft; x < cropRight; x++) {
          let sum = 0;
          for (let c = 0; c < numMaskCoeffs; c++) {
            const protoVal = prototypes[c * protoHeight * protoWidth + y * protoWidth + x] ?? 0;
            sum += (coeffs[c] ?? 0) * protoVal;
          }
          const maskVal = 1 / (1 + Math.exp(-sum));
          buffer[bufferIdx++] = maskVal > 0.5 ? 1 : 0;
        }
      }
      encodedMask = encodeMaskRLE(buffer, croppedWidth, croppedHeight);
    } else {
      encodedMask = { width: 0, height: 0, startValue: 0 as const, runs: [] };
    }

    const prediction: IElementPrediction = {
      classId,
      className,
      probability: confidence,
      boundingBox: {
        x: Math.floor(clampedX1 * scaleX),
        y: Math.floor(clampedY1 * scaleY),
        width: Math.round((clampedX2 - clampedX1) * scaleX),
        height: Math.round((clampedY2 - clampedY1) * scaleY),
      },
      masks: encodedMask,
    };

    predictions.push(prediction);
  }

  return predictions;
}
