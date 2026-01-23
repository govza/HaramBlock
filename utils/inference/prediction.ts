import * as tf from '@tensorflow/tfjs';

import { edgeBoundingBoxCorrection } from '@/entrypoints/background/modelUtils/corrections';
import { calculateScaleFactors } from '@/entrypoints/background/modelUtils/maskTransform';
import { createCacheMetadataFromMediaMetadata } from '@/utils/cacheUtils';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { loadModel } from '@/utils/inference/modelLoader';
import { loadImageBitmap, tensorFromImageBitmap } from '@/utils/inference/preprocessing';
import { logger } from '@/utils/logger';
import { encodeMaskRLE } from '@/utils/rle';

import type { IElementPrediction, IImagePrediction, IMaskTransform, Metadata } from '@/utils/types';
import type { InferenceTask } from '@/utils/types/model';

export async function processInferenceTask(task: InferenceTask): Promise<IImagePrediction> {
  const startTime = Date.now();

  try {
    const { model, config } = await loadModel();

    // Use provided bitmap/blob (from MessageChannel/structured clone) or fetch from URL
    let imageBitmap: ImageBitmap;
    let fetchTime = 0;
    let bitmapTime = 0;
    let imageWidth: number;
    let imageHeight: number;

    if (task.bitmap) {
      // Use pre-loaded bitmap (zero-copy transfer from content script via MessageChannel)
      imageBitmap = task.bitmap;
      imageWidth = task.originalWidth || imageBitmap.width;
      imageHeight = task.originalHeight || imageBitmap.height;
      logger.withTag('prediction').debug(`Using pre-loaded bitmap for ${task.imageSrc}`);
    } else if (task.blob) {
      // Convert blob to bitmap (Firefox structured clone path)
      const bitmapStartTime = Date.now();
      imageBitmap = await createImageBitmap(task.blob);
      bitmapTime = Date.now() - bitmapStartTime;
      imageWidth = task.originalWidth || imageBitmap.width;
      imageHeight = task.originalHeight || imageBitmap.height;
      logger.withTag('prediction').debug(`Created bitmap from blob for ${task.imageSrc} in ${bitmapTime}ms`);
    } else {
      // Fetch and decode image from URL
      const loaded = await loadImageBitmap(task.imageSrc);
      ({ imageBitmap, fetchTime, bitmapTime } = loaded);
      imageWidth = imageBitmap.width;
      imageHeight = imageBitmap.height;
    }

    const inferenceStartTime = Date.now();
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
    const inferenceTime = Date.now() - inferenceStartTime;

    const predictions = edgeBoundingBoxCorrection(rawPredictions, imageBitmap.width, imageBitmap.height);
    const processingTimeMs = Date.now() - startTime;
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
        bitmapTime,
        inferenceTime,
      },
      forcedVisibility: null,
    };

    logger
      .withTag('prediction')
      .info(
        `Completed image inference task for ${task.imageSrc} in ${processingTimeMs}ms (fetch: ${fetchTime}ms, bitmap: ${bitmapTime}ms, inference: ${inferenceTime}ms) with ${predictions.length} predictions`,
      );

    return result;
  } catch (error) {
    logger.withTag('prediction').error(`Failed to process image task for ${task.imageSrc}:`, error);
    throw new Error(`Failed to process image task for ${task.imageSrc}`, { cause: error });
  }
}

/**
 *  Get predictions for a single image frame.
 *  This method handles the core inference logic, including model execution and post-processing.
 * @param imageBitmap
 * @param model
 * @param config
 * @param scoreThreshold
 * @returns Promise<IElementPrediction[]>
 */
async function getFramePredictions(
  imageBitmap: ImageBitmap,
  model: tf.GraphModel,
  config: Metadata,
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
  config: Metadata,
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
    const outH = config.outputShape[0];
    const outW = config.outputShape[1];
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

    // Extract mask arrays per detection to reduce peak memory usage

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
      const encodedMask = encodeMaskRLE(maskArray);

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
