import * as tf from '@tensorflow/tfjs';

import { edgeBoundingBoxCorrection } from '@/entrypoints/background/modelUtils/corrections';
import { calculateScaleFactors } from '@/entrypoints/background/modelUtils/maskTransform';
import { createCacheMetadataFromMediaMetadata } from '@/utils/cacheUtils';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { loadImageBitmap } from '@/utils/inference/preprocessing';
import { getBackend, loadModel } from '@/utils/inference/runtimes/tfjs/modelLoader';
import { logger } from '@/utils/logger';
import { encodeMaskRLE } from '@/utils/rle';

import type { IElementPrediction, IImagePrediction, IMaskTransform, ModelMetadata } from '@/utils/types';
import type { InferenceTask } from '@/utils/types/model';

/**
 * Converts ImageBitmap to TensorFlow tensor with proper preprocessing
 * using TF ops (no canvas). Maintains aspect ratio via letterboxing
 * to match the model's expected [width, height].
 */
function tensorFromImageBitmap(imageBitmap: ImageBitmap, imgsz: [number, number]): tf.Tensor4D {
  const [modelW, modelH] = imgsz;

  return tf.tidy(() => {
    // 1) Create tensor directly from ImageBitmap and normalize
    const img: tf.Tensor3D = tf.browser.fromPixels(imageBitmap).toFloat().div(255);

    const [h, w] = img.shape;
    const scale = Math.min(modelW / w, modelH / h);
    const newW = Math.max(1, Math.round(w * scale));
    const newH = Math.max(1, Math.round(h * scale));

    // 2) Aspect-preserving resize
    const resized: tf.Tensor3D = tf.image.resizeBilinear(img, [newH, newW], true);

    // 3) Letterbox to target size with black padding
    const padLeft = Math.floor((modelW - newW) / 2);
    const padRight = modelW - newW - padLeft;
    const padTop = Math.floor((modelH - newH) / 2);
    const padBottom = modelH - newH - padTop;

    const padded: tf.Tensor3D = tf.pad(resized, [
      [padTop, padBottom],
      [padLeft, padRight],
      [0, 0],
    ]);

    // 4) Add batch dimension
    return padded.expandDims(0);
  });
}

export async function processInferenceTask(task: InferenceTask): Promise<IImagePrediction> {
  try {
    // Calculate queue time immediately to avoid double-counting fetch/decode time
    const taskStartAt = Date.now();
    const queueTime = task.queueStartAt ? taskStartAt - task.queueStartAt : 0;

    const { model, config } = await loadModel();

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

    const rawPredictions = await getFramePredictions(
      imageBitmap,
      model,
      config,
      scoreThreshold,
      imageWidth,
      imageHeight,
    );
    const inferenceEndAt = Date.now();
    const inferenceTime = inferenceEndAt - inferenceStartAt;

    // Calculate E2E time: from content script request start to inference completion
    const e2eTime = task.requestStartAt ? inferenceEndAt - task.requestStartAt : 0;

    const predictions = edgeBoundingBoxCorrection(rawPredictions, imageBitmap.width, imageBitmap.height);
    const timestamp = Date.now();

    const cacheMetadata = createCacheMetadataFromMediaMetadata(task.mediaMetadata);

    // Calculate mask transform parameters in mask-grid space (outputShape H/W)
    const maskTransform: IMaskTransform = calculateScaleFactors(
      imageWidth,
      imageHeight,
      config.outputShape[0],
      config.outputShape[1],
    );

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
      forcedVisibility: null,
    };

    return result;
  } catch (error) {
    logger.withTag('prediction').error(`Failed to process image task for ${task.imageSrc}:`, error);
    throw new Error(`Failed to process image task for ${task.imageSrc}`, { cause: error });
  }
}

/**
 * Get predictions for a single image frame.
 */
async function getFramePredictions(
  imageBitmap: ImageBitmap,
  model: tf.GraphModel,
  config: ModelMetadata,
  scoreThreshold: number,
  originalWidth: number,
  originalHeight: number,
): Promise<IElementPrediction[]> {
  const [modelHeight, modelWidth] = config.imgsz;

  try {
    // Prepare model input
    const input = tensorFromImageBitmap(imageBitmap, [modelWidth, modelHeight]);
    // Compute letterbox factors relative to the natural/original image dimensions
    const { scaleX, scaleY, offsetX, offsetY } = calculateScaleFactors(
      originalWidth,
      originalHeight,
      modelWidth,
      modelHeight,
    );

    const originalWarn = console.warn;
    console.warn = () => {};
    const result = (await model.executeAsync(input)) as tf.Tensor[];
    console.warn = originalWarn;

    logger
      .withTag('prediction')
      .debug(
        `Model execution completed. Output tensors: ${result.length}, shapes: ${result.map(t => `[${t.shape.join(',')}]`).join(', ')}`,
      );

    const predictions = await processSegmentationResults(
      result,
      config,
      scaleX,
      scaleY,
      offsetX,
      offsetY,
      scoreThreshold,
    );

    input.dispose();
    result.forEach(tensor => tensor.dispose());

    return predictions;
  } catch (error) {
    logger.withTag('prediction').error('Error in getFramePredictions:', error);
    throw error;
  }
}

async function processSegmentationResults(
  result: tf.Tensor[],
  config: ModelMetadata,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number,
  scoreThreshold: number,
): Promise<IElementPrediction[]> {
  try {
    if (result.length < 3 || !result[0] || !result[2]) {
      throw new Error('Invalid segmentation model output: expected at least 3 tensors');
    }

    const detectionTensor = result[0].squeeze();
    const maskWeightTensor = result[2].squeeze();
    const scoreSlice = detectionTensor.slice([0, 4], [-1, 1]).squeeze();

    const boxIndexes = scoreSlice.greater(scoreThreshold);

    const filteredDetections = await tf.booleanMaskAsync(detectionTensor, boxIndexes);
    const numFilteredDetections = filteredDetections.shape[0];

    logger
      .withTag('prediction')
      .debug(`Found ${numFilteredDetections} detections above score threshold ${scoreThreshold}`);

    if (numFilteredDetections === 0) {
      logger.withTag('prediction').debug('No detections found above score threshold, returning empty results');
      scoreSlice.dispose();
      boxIndexes.dispose();
      filteredDetections.dispose();
      return [];
    }

    const totalFeatures = filteredDetections.shape[1] || 0;
    const segmentationStartIndex = 6;
    const segmentationCoeffs = totalFeatures - segmentationStartIndex;

    if (segmentationCoeffs <= 0) {
      logger.withTag('prediction').warn('No segmentation coefficients found in detection tensor');
      scoreSlice.dispose();
      boxIndexes.dispose();
      filteredDetections.dispose();
      return [];
    }

    const vectors = filteredDetections.slice([0, segmentationStartIndex], [-1, -1]);
    const [outH, outW] = config.outputShape;
    const maskWeightReshaped = maskWeightTensor.reshape([outH * outW, segmentationCoeffs]);
    const transponsedVectors = vectors.transpose([1, 0]);
    const maskWeightShapeForMatMul = maskWeightReshaped.shape;
    const transposedShape = transponsedVectors.shape;

    if (maskWeightShapeForMatMul[1] !== transposedShape[0]) {
      logger
        .withTag('prediction')
        .error(`Matrix multiplication shape mismatch: ${maskWeightShapeForMatMul[1]} !== ${transposedShape[0]}`);
      scoreSlice.dispose();
      boxIndexes.dispose();
      filteredDetections.dispose();
      vectors.dispose();
      maskWeightReshaped.dispose();
      transponsedVectors.dispose();
      return [];
    }

    const dotProduct = tf.matMul(maskWeightReshaped, transponsedVectors);
    const probabilityMap = dotProduct.sigmoid();
    // Use a fixed mask threshold; detection score is not an appropriate mask cutoff
    const maskThreshold = 0.5;
    const binaryMask = probabilityMap.greater(maskThreshold);
    const masks = binaryMask.transpose([1, 0]).reshape([numFilteredDetections, outH, outW]);

    const predictions: IElementPrediction[] = [];
    const detectionsArray = (await filteredDetections.array()) as number[][];
    const masksArr = (await masks.array()) as number[][][]; // [N, H, W]

    for (let i = 0; i < numFilteredDetections; i++) {
      const detectionArray = detectionsArray[i];
      if (!detectionArray || detectionArray.length < 6) continue;

      const x1 = detectionArray[0];
      const y1 = detectionArray[1];
      const x2 = detectionArray[2];
      const y2 = detectionArray[3];
      const score = detectionArray[4];
      const classLabel = detectionArray[5];
      if (
        typeof x1 !== 'number' ||
        typeof y1 !== 'number' ||
        typeof x2 !== 'number' ||
        typeof y2 !== 'number' ||
        typeof score !== 'number' ||
        typeof classLabel !== 'number'
      ) {
        continue;
      }

      const labelIndex = Math.floor(classLabel);
      const className = config.names[labelIndex % Object.keys(config.names).length] || 'unknown';

      if (!config.namesToCheck.includes(className)) {
        continue;
      }

      // Apply coordinate transform to bounding box
      const modelX1 = x1 - offsetX;
      const modelY1 = y1 - offsetY;
      const modelX2 = x2 - offsetX;
      const modelY2 = y2 - offsetY;

      const maskArray = masksArr[i] as number[][];
      // Flatten 2D mask array to Uint8Array for RLE encoding
      const [outH, outW] = config.outputShape;
      const flatMask = new Uint8Array(outH * outW);
      for (let my = 0; my < outH; my++) {
        const row = maskArray[my];
        if (!row) continue;
        for (let mx = 0; mx < outW; mx++) {
          flatMask[my * outW + mx] = row[mx] ? 1 : 0;
        }
      }
      const encodedMask = encodeMaskRLE(flatMask, outW, outH);

      const prediction: IElementPrediction = {
        classId: labelIndex,
        className,
        probability: score,
        boundingBox: {
          x: Math.floor(modelX1 * scaleX),
          y: Math.floor(modelY1 * scaleY),
          width: Math.round((modelX2 - modelX1) * scaleX),
          height: Math.round((modelY2 - modelY1) * scaleY),
        },
        masks: encodedMask,
      };
      predictions.push(prediction);
    }

    scoreSlice.dispose();
    boxIndexes.dispose();
    filteredDetections.dispose();
    vectors.dispose();
    maskWeightReshaped.dispose();
    transponsedVectors.dispose();
    dotProduct.dispose();
    probabilityMap.dispose();
    binaryMask.dispose();
    masks.dispose();

    logger
      .withTag('prediction')
      .debug(`Processed ${numFilteredDetections} detections, returning ${predictions.length} valid predictions`);

    return predictions;
  } catch (error) {
    logger.withTag('prediction').error('Error in processSegmentationResults:', error);
    throw error;
  }
}
