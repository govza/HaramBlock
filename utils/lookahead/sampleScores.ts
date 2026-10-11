import { edgeBoundingBoxCorrection } from '@/entrypoints/background/modelUtils/corrections';
import { predictionsFromScoreGrid } from '@/utils/scoreGrid';

import type { InferredSample } from '@/utils/lookahead/ports';
import type { IElementPrediction, IScoreGrid, RawSampleScores } from '@/utils/types';

const SUSPICION_RATIO = 0.5;

export const suspicionThresholdOf = (scoreThreshold: number): number => scoreThreshold * SUSPICION_RATIO;

export function rawScoresOf(prediction: {
  predictions: IElementPrediction[];
  scoreGrid?: IScoreGrid;
}): RawSampleScores {
  if (prediction.scoreGrid) return { kind: 'grid', grid: prediction.scoreGrid };
  return { kind: 'detections', detections: prediction.predictions };
}

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
