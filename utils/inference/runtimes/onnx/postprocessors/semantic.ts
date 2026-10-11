import { calculateLetterboxParams, calculateScaleFactors } from '@/entrypoints/background/modelUtils/maskTransform';
import { encodeScoreGrid, quantizeProbability, SemanticCells, type GridGeometry } from '@/utils/scoreGrid';
import { getLogger } from '@/utils/telemetry';

import type { PostprocessContext, PostprocessResult } from '@/utils/inference/runtimes/onnx/postprocessors/types';

const log = getLogger('prediction');

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
  includeScoreGrid = false,
}: PostprocessContext): PostprocessResult {
  const [modelHeight, modelWidth] = config.imgsz;

  const output = results['output0'];
  if (!output) {
    log.error('postprocess.tensor.missing', { tensorName: 'output0', availableTensors: Object.keys(results) });
    return { predictions: [], topUnsafeScore: 0 };
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

  const contentWidth = modelWidth - 2 * offsetX;
  const contentHeight = modelHeight - 2 * offsetY;
  const geometry: GridGeometry = {
    width: subW,
    height: subH,
    cellWidth: step * (contentWidth / croppedWidth) * scaleX,
    cellHeight: step * (contentHeight / croppedHeight) * scaleY,
  };
  const classNameOf = (classId: number) => config.names[classId] ?? `class_${classId}`;
  const cells = new SemanticCells(geometry, classNameOf);
  const gridProbabilities = includeScoreGrid ? new Uint8Array(subW * subH) : null;
  const gridClassIds = includeScoreGrid ? new Uint8Array(subW * subH) : null;

  let topUnsafeScore = 0;
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

      if (targetClassIndices.has(maxClass)) {
        let expSum = 0;
        for (let c = 0; c < numClasses; c++) {
          expSum += Math.exp((data[c * spatial + y * outW + x] ?? 0) - maxLogit);
        }
        const prob = 1 / expSum;
        topUnsafeScore = Math.max(topUnsafeScore, prob);
        if (prob >= scoreThreshold) cells.add(bufferIdx, maxClass, prob);
        if (gridProbabilities && gridClassIds) {
          gridProbabilities[bufferIdx] = quantizeProbability(prob);
          gridClassIds[bufferIdx] = maxClass;
        }
      }

      bufferIdx++;
    }
  }

  const predictions = cells.predictions(targetClassIndices);
  if (!gridProbabilities || !gridClassIds) return { predictions, topUnsafeScore };
  const classNames = Object.fromEntries([...targetClassIndices].map(classId => [classId, classNameOf(classId)]));
  return {
    predictions,
    topUnsafeScore,
    scoreGrid: encodeScoreGrid(geometry, gridProbabilities, gridClassIds, classNames),
  };
}
