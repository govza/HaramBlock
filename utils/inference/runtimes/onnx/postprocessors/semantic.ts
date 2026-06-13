import { calculateLetterboxParams, calculateScaleFactors } from '@/entrypoints/background/modelUtils/maskTransform';
import { logger } from '@/utils/logger';
import { encodeMaskRLE } from '@/utils/rle';

import type { PostprocessContext } from '@/utils/inference/runtimes/onnx/postprocessors/types';
import type { IElementPrediction } from '@/utils/types';

interface ClassAccumulator {
  mask: Uint8Array;
  confSum: number;
  pixelCount: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Process semantic segmentation output.
 * Output: [batch, num_classes, H, W] - per-pixel class logits.
 * Creates one prediction per target class found, with a full-resolution mask.
 */
export function processSemanticSegmentation({
  results,
  config,
  scoreThreshold,
  originalWidth,
  originalHeight,
}: PostprocessContext): IElementPrediction[] {
  const [modelHeight, modelWidth] = config.imgsz;

  const output = results['output0'];
  if (!output) {
    logger.withTag('prediction').error(`Missing 'output0' tensor. Available: ${Object.keys(results).join(', ')}`);
    return [];
  }

  const data = output.data as Float32Array;
  const dims = output.dims as number[];
  const numClasses = dims[1] ?? 0;
  const outH = dims[2] ?? config.outputShape[0];
  const outW = dims[3] ?? config.outputShape[1];
  const spatial = outH * outW;

  const letterboxParams = calculateLetterboxParams(originalWidth, originalHeight, modelWidth, modelHeight, outW, outH);
  const { scaleX, scaleY, offsetX, offsetY } = calculateScaleFactors(
    originalWidth,
    originalHeight,
    modelWidth,
    modelHeight,
  );

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
