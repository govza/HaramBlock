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

    const rawPredictions = await getFramePredictions(
      imageBitmap,
      session,
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

    // Calculate mask transform parameters for mask overlays
    // Since masks are now cropped to remove letterbox padding, use simple scale (no offset)
    const [modelHeight, modelWidth] = config.imgsz;
    const [protoHeight, protoWidth] = config.outputShape;
    const letterboxParams = calculateLetterboxParams(
      imageWidth,
      imageHeight,
      modelWidth,
      modelHeight,
      protoWidth,
      protoHeight,
    );

    // Cropped mask maps directly to original image (scale only, no offset)
    const maskTransform: IMaskTransform = {
      scaleX: imageWidth / letterboxParams.contentProtoWidth,
      scaleY: imageHeight / letterboxParams.contentProtoHeight,
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
      forcedVisibility: null,
    };

    return result;
  } catch (error) {
    logger.withTag('prediction').error(`Failed to process image task for ${task.imageSrc}:`, error);
    throw new Error(`Failed to process image task for ${task.imageSrc}`, { cause: error });
  }
}

/**
 * Get predictions for a single image frame using YOLO instance segmentation.
 */
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
    // Preprocess image to NCHW Float32Array
    const tensorData = preprocessImage(imageBitmap, config);

    // Create ONNX tensor
    const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, modelHeight, modelWidth]);

    // Run inference
    const feeds: Record<string, typeof inputTensor> = { [config.inputName]: inputTensor };
    const results = await session.run(feeds);

    logger.withTag('prediction').debug(`ONNX outputs: ${Object.keys(results).join(', ')}`);

    // Get prototype dimensions from masks output (if available)
    const masksOutput = results[config.outputNames.masks];
    const protoDims = masksOutput?.dims as number[] | undefined;
    const protoHeight = protoDims?.[2] ?? config.outputShape[0];
    const protoWidth = protoDims?.[3] ?? config.outputShape[1];

    // Calculate letterbox transform for coordinate conversion (includes prototype space offsets)
    const letterboxParams = calculateLetterboxParams(
      originalWidth,
      originalHeight,
      modelWidth,
      modelHeight,
      protoWidth,
      protoHeight,
    );

    // Also get scale factors for bounding box conversion
    const { scaleX, scaleY, offsetX, offsetY } = calculateScaleFactors(
      originalWidth,
      originalHeight,
      modelWidth,
      modelHeight,
    );

    // Process YOLO segmentation output
    // Cast results to expected type - YOLO outputs are always numeric tensors
    const predictions = processSegmentation(
      results as Record<string, { data: ArrayLike<number>; dims: readonly number[] }>,
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

    // Cleanup
    inputTensor.dispose();
    for (const key of Object.keys(results)) {
      results[key]?.dispose();
    }

    return predictions;
  } catch (error) {
    logger.withTag('prediction').error('Error in getFramePredictions:', error);
    throw error;
  }
}

/**
 * Process YOLO instance segmentation output.
 * Handles YOLO11 seg model output format with NMS enabled.
 *
 * Expected output format (with nms=True):
 * - detections: [batch, num_dets, 38] = [x1, y1, x2, y2, conf, cls, mask_coeffs(32)]
 * - masks: [batch, 32, mask_h, mask_w] = prototype masks
 *
 * Output tensor names are configurable via config.outputNames (defaults: output0, output1).
 * The final instance mask = sigmoid(mask_coeffs @ prototypes)
 * Masks are cropped to remove letterbox padding before encoding.
 */
function processSegmentation(
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

  // Get output tensors using configurable names from metadata
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

  // Dims: detections [batch, num_dets, features]
  const numDetections = detsDims[1] ?? 0;
  const numFeatures = detsDims[2] ?? 0;

  // Check if we have mask coefficients (38 = 4 box + 1 conf + 1 cls + 32 coeffs)
  const hasMaskCoeffs = numFeatures >= 38;
  const numMaskCoeffs = hasMaskCoeffs ? 32 : 0;

  // Get prototype masks if available
  let prototypes: Float32Array | undefined;
  let protoHeight = 0;
  let protoWidth = 0;
  if (masksOutput && hasMaskCoeffs) {
    prototypes = masksOutput.data as Float32Array;
    const protoDims = masksOutput.dims as number[];
    // masks: [batch, 32, mask_h, mask_w]
    protoHeight = protoDims[2] ?? 0;
    protoWidth = protoDims[3] ?? 0;
  }

  logger
    .withTag('prediction')
    .debug(
      `Processing YOLO output: ${numDetections} detections, ${numFeatures} features, ` +
        `prototypes: ${prototypes ? `${protoHeight}x${protoWidth}` : 'none'}`,
    );

  // Build target class index map
  const targetClassIndices: Set<number> = new Set();
  for (const targetName of config.namesToCheck) {
    const entry = Object.entries(config.names).find(([, name]) => name === targetName);
    if (entry) {
      targetClassIndices.add(Number(entry[0]));
    }
  }

  for (let i = 0; i < numDetections; i++) {
    const baseIdx = i * numFeatures;

    // YOLO output format: [x1, y1, x2, y2, conf, cls, ...mask_coeffs]
    const x1 = detections[baseIdx] ?? 0;
    const y1 = detections[baseIdx + 1] ?? 0;
    const x2 = detections[baseIdx + 2] ?? 0;
    const y2 = detections[baseIdx + 3] ?? 0;
    const confidence = detections[baseIdx + 4] ?? 0;
    const classId = Math.round(detections[baseIdx + 5] ?? 0);

    // Skip if below threshold or not a target class
    if (confidence < scoreThreshold || !targetClassIndices.has(classId)) {
      continue;
    }

    const className = config.names[classId] ?? `class_${classId}`;

    // Apply letterbox offset and scale to original image coordinates
    // YOLO outputs pixel coordinates in model space
    const modelX1 = x1 - offsetX;
    const modelY1 = y1 - offsetY;
    const modelX2 = x2 - offsetX;
    const modelY2 = y2 - offsetY;

    // Skip if entirely in padding area
    const contentWidth = modelWidth - 2 * offsetX;
    const contentHeight = modelHeight - 2 * offsetY;
    if (modelX2 < 0 || modelY2 < 0 || modelX1 > contentWidth || modelY1 > contentHeight) {
      continue;
    }

    // Clamp to valid range
    const clampedX1 = Math.max(0, modelX1);
    const clampedY1 = Math.max(0, modelY1);
    const clampedX2 = Math.min(contentWidth, modelX2);
    const clampedY2 = Math.min(contentHeight, modelY2);

    // Compute instance mask from coefficients and prototypes
    let encodedMask;
    if (prototypes && hasMaskCoeffs && protoHeight > 0 && protoWidth > 0) {
      // Extract mask coefficients for this detection
      const coeffs: number[] = [];
      for (let c = 0; c < numMaskCoeffs; c++) {
        coeffs.push(detections[baseIdx + 6 + c] ?? 0);
      }

      // Get letterbox crop bounds in prototype space
      const { protoOffsetX, protoOffsetY } = letterboxParams;

      // Calculate crop boundaries (with rounding matching Python reference)
      const cropLeft = Math.round(protoOffsetX - 0.1);
      const cropTop = Math.round(protoOffsetY - 0.1);
      const cropRight = Math.round(protoWidth - protoOffsetX + 0.1);
      const cropBottom = Math.round(protoHeight - protoOffsetY + 0.1);

      // Compute mask and crop in one pass using reusable flat buffer
      const croppedWidth = cropRight - cropLeft;
      const croppedHeight = cropBottom - cropTop;
      const buffer = getMaskBuffer(croppedWidth * croppedHeight);

      let bufferIdx = 0;
      for (let y = cropTop; y < cropBottom; y++) {
        for (let x = cropLeft; x < cropRight; x++) {
          let sum = 0;
          for (let c = 0; c < numMaskCoeffs; c++) {
            // prototypes: [1, 32, H, W] - access as prototypes[c * H * W + y * W + x]
            const protoVal = prototypes[c * protoHeight * protoWidth + y * protoWidth + x] ?? 0;
            sum += (coeffs[c] ?? 0) * protoVal;
          }
          // Apply sigmoid and threshold
          const maskVal = 1 / (1 + Math.exp(-sum));
          buffer[bufferIdx++] = maskVal > 0.5 ? 1 : 0;
        }
      }
      encodedMask = encodeMaskRLE(buffer, croppedWidth, croppedHeight);
    } else {
      // Empty mask placeholder
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

  logger.withTag('prediction').debug(`Processed YOLO segmentation: ${predictions.length} target detections`);

  return predictions;
}
