import { calculateLetterboxParams, calculateScaleFactors } from '@/entrypoints/background/modelUtils/maskTransform';
import { logger } from '@/utils/logger';
import { encodeMaskRLE } from '@/utils/rle';

import type { PostprocessContext } from '@/utils/inference/runtimes/onnx/postprocessors/types';
import type { IElementPrediction } from '@/utils/types';

let maskBuffer: Uint8Array | null = null;

function getMaskBuffer(size: number): Uint8Array {
  if (!maskBuffer || maskBuffer.length < size) {
    maskBuffer = new Uint8Array(size);
  }
  return maskBuffer;
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
export function processInstanceSegmentation({
  results,
  config,
  scoreThreshold,
  originalWidth,
  originalHeight,
}: PostprocessContext): IElementPrediction[] {
  const [modelHeight, modelWidth] = config.imgsz;
  const { detections: detectionsName, masks: masksName } = config.outputNames;

  const detectionsOutput = results[detectionsName];
  const masksOutput = results[masksName];

  const predictions: IElementPrediction[] = [];

  if (!detectionsOutput) {
    logger
      .withTag('prediction')
      .error(`Missing '${detectionsName}' tensor. Available: ${Object.keys(results).join(', ')}`);
    return predictions;
  }

  const masksDims = masksOutput?.dims as number[] | undefined;
  const letterboxParams = calculateLetterboxParams(
    originalWidth,
    originalHeight,
    modelWidth,
    modelHeight,
    masksDims?.[3] ?? config.outputShape[1],
    masksDims?.[2] ?? config.outputShape[0],
  );
  const { scaleX, scaleY, offsetX, offsetY } = calculateScaleFactors(
    originalWidth,
    originalHeight,
    modelWidth,
    modelHeight,
  );

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
