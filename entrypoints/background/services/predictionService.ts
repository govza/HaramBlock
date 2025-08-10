import * as tf from '@tensorflow/tfjs';

import { type InferenceTask } from '@/entrypoints/background/domain/models';
import { edgeBoundingBoxCorrection } from '@/entrypoints/background/domain/models/corrections';
import { type ModelLoaderService, type ImageProcessorService } from '@/entrypoints/background/services';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { logger } from '@/utils/logger';
import { type IElementPrediction, type IImagePrediction, type Metadata } from '@/utils/types';

export class PredictionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PredictionError';
    this.cause = cause;
  }
}

export class PredictionService {
  constructor(
    private modelLoaderService: ModelLoaderService,
    private imageProcessor: ImageProcessorService,
  ) {}

  async processInferenceTask(task: InferenceTask): Promise<IImagePrediction> {
    const startTime = Date.now();

    try {
      logger.withTag('predictionService').debug(`Processing inference task ${task.id}...`);

      // 1. Load the model and get config
      const model = await this.modelLoaderService.loadModelAsync();
      const config = this.modelLoaderService.getModelConfig();

      // 2. Load and preprocess the image
      const imageBitmap = await this.imageProcessor.loadImageBitmap(task.imageSrc);
      const { width: imageWidth, height: imageHeight } = this.imageProcessor.getImageDimensions(imageBitmap);

      // 3. Run inference through integrated prediction processing
      const rawPredictions = await this.getFramePredictions(
        imageBitmap,
        model,
        config,
        1 - task.hostSettings.strictness,
      );

      // 3.1. Apply edge bounding box correction
      const predictions = edgeBoundingBoxCorrection(rawPredictions, imageWidth, imageHeight);

      // 4. Create result
      const processingTimeMs = Date.now() - startTime;
      const timestamp = Date.now();

      // Create cache metadata from real image metadata or defaults
      const cacheControlHeader = task.imageMetadata?.cacheControl;
      const contentType = task.imageMetadata?.contentType ?? 'image/jpeg';

      const maxAge = typeof cacheControlHeader === 'string' ? (this.extractMaxAge(cacheControlHeader) ?? 3600) : 3600;

      const cacheMetadata = {
        createdAt: timestamp,
        accessedAt: timestamp,
        maxAge,
        cacheControl: cacheControlHeader || `max-age=${maxAge}`,
        contentType,
      };

      const result: IImagePrediction = {
        hostname: getEffectiveHostname(task.hostname),
        src: task.imageSrc,
        imageWidth,
        imageHeight,
        predictions,
        timestamp,
        cacheMetadata,
      };

      logger
        .withTag('predictionService')
        .info(`Completed inference task ${task.id} in ${processingTimeMs}ms with ${predictions.length} predictions`);

      return result;
    } catch (error) {
      logger.withTag('predictionService').error(`Failed to process task ${task.id}:`, error);
      throw new PredictionError(`Failed to process task ${task.id}`, error);
    }
  }

  private async getFramePredictions(
    imageBitmap: ImageBitmap,
    model: tf.GraphModel,
    config: Metadata,
    scoreThreshold: number,
  ): Promise<IElementPrediction[]> {
    const [modelHeight, modelWidth] = config.imgsz;

    try {
      const { width: originalWidth, height: originalHeight } = this.imageProcessor.getImageDimensions(imageBitmap);
      const input = this.imageProcessor.tensorFromImageBitmap(imageBitmap, [modelWidth, modelHeight]);
      const { scaleX, scaleY, offsetX, offsetY } = this.imageProcessor.calculateScaleFactors(
        originalWidth,
        originalHeight,
        modelWidth,
        modelHeight,
      );

      // Run model inference
      // Suppress false warnings
      const originalWarn = console.warn;
      console.warn = () => {};

      const result = (await model.executeAsync(input)) as tf.Tensor2D[];
      console.warn = originalWarn;

      // Process segmentation using the working approach from examples
      const predictions = await this.processSegmentationResults(
        result,
        config,
        scaleX,
        scaleY,
        offsetX,
        offsetY,
        scoreThreshold,
      );

      // Dispose tensors
      input.dispose();
      result.forEach(tensor => tensor.dispose());

      return predictions;
    } catch (error) {
      logger.withTag('predictionService').error('Error in getFramePredictions:', error);
      throw error;
    }
  }

  private async processSegmentationResults(
    result: tf.Tensor2D[],
    config: Metadata,
    scaleX: number,
    scaleY: number,
    offsetX: number,
    offsetY: number,
    scoreThreshold: number,
  ): Promise<IElementPrediction[]> {
    try {
      if (!result || result.length < 3) {
        logger.withTag('predictionService').error('Invalid model output: expected at least 3 tensors for segmentation');
        return [];
      }

      // Extract tensors following the working segmentation approach
      if (!result[0] || !result[2]) {
        logger.withTag('predictionService').error('Model output missing expected tensors for segmentation');
        return [];
      }
      const detectionTensor = result[0].squeeze(); // Main detection tensor
      const maskWeightTensor = result[2].squeeze(); // Segmentation weights/prototypes

      // Filter detections based on score threshold (following working approach)
      const scoreSlice = detectionTensor.slice([0, 4], [-1, 1]).squeeze();
      const boxIndexes = scoreSlice.greater(scoreThreshold);

      const filteredDetections = await tf.booleanMaskAsync(detectionTensor, boxIndexes);
      const numFilteredDetections = filteredDetections.shape[0];

      if (numFilteredDetections === 0) {
        scoreSlice.dispose();
        boxIndexes.dispose();
        filteredDetections.dispose();
        return [];
      }

      // Extract segmentation coefficients (following working approach exactly)
      // In working code: vectors = filteredBbox.slice([0, 6], [-1, -1])
      // This means segmentation coefficients start at position 6 (after x,y,w,h,score,class)
      const totalFeatures = filteredDetections.shape[1] || 0;
      const segmentationStartIndex = 6; // Fixed position as in working code
      const segmentationCoeffs = totalFeatures - segmentationStartIndex;

      if (segmentationCoeffs <= 0) {
        logger.withTag('predictionService').warn('No segmentation coefficients found in detection tensor');
        scoreSlice.dispose();
        boxIndexes.dispose();
        filteredDetections.dispose();
        return [];
      }

      // Get segmentation coefficients (vectors) from filtered detections - exactly like working code
      const vectors = filteredDetections.slice([0, segmentationStartIndex], [-1, -1]);

      // Reshape mask weights to matrix format: [160*160, 32] (following working approach)
      const maskWeightReshaped = maskWeightTensor.reshape([160 * 160, segmentationCoeffs]);

      // Transpose vectors for matrix multiplication
      const transponsedVectors = vectors.transpose([1, 0]);

      // Matrix multiplication: mask weights × vectors = probability maps
      const dotProduct = tf.matMul(maskWeightReshaped, transponsedVectors);

      // Apply sigmoid and threshold (following working approach)
      const probabilityMap = dotProduct.sigmoid();
      const binaryMask = probabilityMap.greater(scoreThreshold);
      const masks = binaryMask.transpose([1, 0]).reshape([numFilteredDetections, 160, 160]);

      // Extract predictions from filtered detections
      const predictions: IElementPrediction[] = [];
      const detectionsArray = (await filteredDetections.array()) as number[][];
      // Note: masksArray could be used for more precise polygon extraction in the future
      // const masksArray = await masks.array() as number[][][];

      for (let i = 0; i < numFilteredDetections; i++) {
        const detection = detectionsArray[i];
        if (!detection || detection.length < 6) continue;

        // Following working code structure: [x1, y1, x2, y2, score, class, ...coefficients]
        const x1 = detection[0];
        const y1 = detection[1];
        const x2 = detection[2];
        const y2 = detection[3];
        const score = detection[4];
        const labelFloat = detection[5];

        // Type safety checks
        if (
          typeof x1 !== 'number' ||
          typeof y1 !== 'number' ||
          typeof x2 !== 'number' ||
          typeof y2 !== 'number' ||
          typeof score !== 'number' ||
          typeof labelFloat !== 'number'
        ) {
          continue;
        }

        const labelIndex = Math.floor(labelFloat);
        const className = config.names[labelIndex % Object.keys(config.names).length] || 'unknown';

        // Filter out classes that are not in namesToCheck
        if (!config.namesToCheck.includes(className)) {
          continue;
        }

        // Convert model coordinates back to original image coordinates
        const modelX1 = x1 - offsetX;
        const modelY1 = y1 - offsetY;
        const modelX2 = x2 - offsetX;
        const modelY2 = y2 - offsetY;

        const upSampleBox: [number, number, number, number] = [
          Math.floor(modelY1 * scaleY),
          Math.floor(modelX1 * scaleX),
          Math.round((modelY2 - modelY1) * scaleY),
          Math.round((modelX2 - modelX1) * scaleX),
        ];

        // Create basic bounding box prediction (mask data could be used for more precise polygons)
        const prediction: IElementPrediction = {
          classId: labelIndex,
          className,
          probability: score,
          boundingBox: {
            x: upSampleBox[1],
            y: upSampleBox[0],
            width: upSampleBox[3],
            height: upSampleBox[2],
          },
          polygon: [
            { x: upSampleBox[1], y: upSampleBox[0] },
            { x: upSampleBox[1] + upSampleBox[3], y: upSampleBox[0] },
            {
              x: upSampleBox[1] + upSampleBox[3],
              y: upSampleBox[0] + upSampleBox[2],
            },
            { x: upSampleBox[1], y: upSampleBox[0] + upSampleBox[2] },
          ],
        };

        predictions.push(prediction);
      }

      // Dispose tensors
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

      return predictions;
    } catch (error) {
      logger.withTag('predictionService').error('Error in processSegmentationResults:', error);
      throw error;
    }
  }

  private extractMaxAge(cacheControl: string): number | null {
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    return maxAgeMatch && maxAgeMatch[1] ? parseInt(maxAgeMatch[1], 10) : null;
  }
}
