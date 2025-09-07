import * as tf from '@tensorflow/tfjs';

import { edgeBoundingBoxCorrection } from '@/entrypoints/background/modelUtils/corrections';
import { calculateScaleFactors } from '@/entrypoints/background/modelUtils/maskTransform';
import { createCacheMetadataFromImageMetadata } from '@/utils/cacheUtils';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { logger, extractUrlId } from '@/utils/logger';

import type { InferenceTask } from '@/entrypoints/background/modelUtils/types';
import type { ModelLoaderService, ImageProcessorService } from '@/entrypoints/background/services';
import type { IElementPrediction, IImagePrediction, IMaskTransform, Metadata } from '@/utils/types';

export class PredictionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PredictionError';
    this.cause = cause;
  }
}

export class PredictionService {
  model: tf.GraphModel | null = null;
  constructor(
    private modelLoaderService: ModelLoaderService,
    private imageProcessor: ImageProcessorService,
  ) {}

  async processInferenceTask(task: InferenceTask): Promise<IImagePrediction> {
    const startTime = Date.now();

    try {
      const model = this.model || (await this.modelLoaderService.loadModelAsync());
      const config = this.modelLoaderService.getModelConfig();

      // Prefer provided bitmap (from content via MessageChannel) to avoid refetch/decoding
      let imageBitmap: ImageBitmap;
      let fetchTime: number;
      let bitmapTime: number;

      if (task.bitmap) {
        imageBitmap = task.bitmap;
        fetchTime = 0;
        bitmapTime = 0;
      } else {
        const {
          imageBitmap: loadedBitmap,
          fetchTime: loadFetchTime,
          bitmapTime: loadBitmapTime,
        } = await this.imageProcessor.loadImageBitmap(task.imageSrc);
        imageBitmap = loadedBitmap;
        fetchTime = loadFetchTime;
        bitmapTime = loadBitmapTime;
      }

      const inferenceStartTime = Date.now();
      const rawThreshold = 1 - task.hostSettings.strictness;
      const scoreThreshold = Math.min(0.9, Math.max(0.05, rawThreshold));

      const imageWidth = task.originalWidth || imageBitmap.width;
      const imageHeight = task.originalHeight || imageBitmap.height;

      const rawPredictions = await this.getFramePredictions(
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

      const cacheMetadata = createCacheMetadataFromImageMetadata(task.imageMetadata);

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
        imageWidth,
        imageHeight,
        predictions,
        timestamp,
        cacheMetadata,
        maskTransform,
        processingTime: {
          fetchTime,
          bitmapTime,
          inferenceTime,
        },
      };

      logger
        .withTag('predictionService')
        .info(
          `Completed inference task for ${extractUrlId(task.imageSrc)} in ${processingTimeMs}ms (fetch: ${fetchTime}ms, bitmap: ${bitmapTime}ms, inference: ${inferenceTime}ms) with ${predictions.length} predictions`,
        );

      return result;
    } catch (error) {
      logger.withTag('predictionService').error(`Failed to process task ${task.id}:`, error);
      throw new PredictionError(`Failed to process task ${task.id}`, error);
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
  private async getFramePredictions(
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
      const input = this.imageProcessor.tensorFromImageBitmap(imageBitmap, [modelWidth, modelHeight]);
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
        .withTag('predictionService')
        .debug(
          `Model execution completed. Output tensors: ${result.length}, shapes: ${result.map(t => `[${t.shape.join(',')}]`).join(', ')}`,
        );

      const predictions = await this.processSegmentationResults(
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
      logger.withTag('predictionService').error('Error in getFramePredictions:', error);
      throw error;
    }
  }

  private async processSegmentationResults(
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
        .withTag('predictionService')
        .debug(`Found ${numFilteredDetections} detections above score threshold ${scoreThreshold}`);

      if (numFilteredDetections === 0) {
        logger.withTag('predictionService').debug('No detections found above score threshold, returning empty results');
        scoreSlice.dispose();
        boxIndexes.dispose();
        filteredDetections.dispose();
        return [];
      }

      const totalFeatures = filteredDetections.shape[1] || 0;
      const segmentationStartIndex = 6;
      const segmentationCoeffs = totalFeatures - segmentationStartIndex;

      if (segmentationCoeffs <= 0) {
        logger.withTag('predictionService').warn('No segmentation coefficients found in detection tensor');
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
          .withTag('predictionService')
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
          logger
            .withTag('predictionService')
            .debug(
              `Skipping prediction with class '${className}' (not in namesToCheck: ${config.namesToCheck.join(', ')})`,
            );
          continue;
        }

        // Apply coordinate transform to bounding box
        const modelX1 = x1 - offsetX;
        const modelY1 = y1 - offsetY;
        const modelX2 = x2 - offsetX;
        const modelY2 = y2 - offsetY;

        const maskArray = masksArr[i] as number[][];

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
          masks: maskArray,
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
        .withTag('predictionService')
        .debug(`Processed ${numFilteredDetections} detections, returning ${predictions.length} valid predictions`);

      return predictions;
    } catch (error) {
      logger.withTag('predictionService').error('Error in processSegmentationResults:', error);
      throw error;
    }
  }
}
