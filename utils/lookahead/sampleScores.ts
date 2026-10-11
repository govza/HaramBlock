import { edgeBoundingBoxCorrection } from '@/entrypoints/background/modelUtils/corrections';
import { predictionsFromScoreGrid } from '@/utils/scoreGrid';

import type { InferredSample } from '@/utils/lookahead/ports';
import type { IElementPrediction, IImagePrediction, IScoreGrid, RawSampleScores } from '@/utils/types';

const SUSPICION_RATIO = 0.5;

export const suspicionThresholdOf = (scoreThreshold: number): number => scoreThreshold * SUSPICION_RATIO;

export function rawScoresOf(prediction: {
  predictions: IElementPrediction[];
  scoreGrid?: IScoreGrid;
}): RawSampleScores {
  if (prediction.scoreGrid) return { kind: 'grid', grid: prediction.scoreGrid };
  return { kind: 'detections', detections: prediction.predictions };
}

export const toInferredSample = (
  prediction: Pick<
    IImagePrediction,
    'predictions' | 'scoreGrid' | 'width' | 'height' | 'maskTransform' | 'topUnsafeScore'
  >,
): InferredSample => ({
  scores: rawScoresOf(prediction),
  input: { width: prediction.width, height: prediction.height, maskTransform: prediction.maskTransform },
  topUnsafeScore: prediction.topUnsafeScore ?? 0,
});

export function predictionsAt(
  sample: Pick<InferredSample, 'scores' | 'input'>,
  scoreThreshold: number,
): IElementPrediction[] {
  const { scores, input } = sample;
  if (scores.kind === 'detections') {
    return scores.detections.filter(detection => detection.probability >= scoreThreshold);
  }
  return edgeBoundingBoxCorrection(predictionsFromScoreGrid(scores.grid, scoreThreshold), input.width, input.height);
}

export const isUnsafeAt = (sample: Pick<InferredSample, 'scores' | 'input'>, scoreThreshold: number): boolean =>
  predictionsAt(sample, scoreThreshold).length > 0;
