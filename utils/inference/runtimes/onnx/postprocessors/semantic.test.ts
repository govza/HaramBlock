import { describe, expect, it } from 'vitest';

import { processSemanticSegmentation } from '@/utils/inference/runtimes/onnx/postprocessors/semantic';
import { predictionsFromScoreGrid } from '@/utils/scoreGrid';
import { MIN_SCORE_THRESHOLD } from '@/utils/scoreThreshold';

import type { TypedResults } from '@/utils/inference/runtimes/onnx/postprocessors/types';
import type { IElementPrediction, ModelMetadata } from '@/utils/types';

const MODEL = 64;
const OUT = 16;
const CLASSES = 4;

const config: ModelMetadata = {
  names: { 0: 'background', 1: 'breast', 2: 'genitals', 3: 'face' },
  imgsz: [MODEL, MODEL],
  normalize: null,
  namesToCheck: ['breast', 'genitals'],
  outputShape: [OUT, OUT],
  inputName: 'images',
  outputNames: { detections: 'output0', masks: 'output1' },
  stride: 32,
  task: 'semantic',
  dynamicBatch: false,
};

function logits(cellLogits: (x: number, y: number) => number[]): TypedResults {
  const spatial = OUT * OUT;
  const data = new Float32Array(CLASSES * spatial);
  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      cellLogits(x, y).forEach((logit, c) => {
        data[c * spatial + y * OUT + x] = logit;
      });
    }
  }
  return { output0: { data, dims: [1, CLASSES, OUT, OUT] } };
}

const gradedScene = logits((x, y) => {
  if (x < 8 && y < 8) return [0, (x + y) / 3, 0, 0];
  if (x >= 10 && y >= 10) return [0, 0, 1 + (x - 10) / 2, 0];
  if (x === 12 && y < 4) return [0, 0, 0, 5];
  return [3, 0, 0, 0];
});

function run(scoreThreshold: number, includeScoreGrid = false, size = { width: 128, height: 96 }) {
  return processSemanticSegmentation({
    results: gradedScene,
    config,
    scoreThreshold,
    originalWidth: size.width,
    originalHeight: size.height,
    includeScoreGrid,
  });
}

const byClass = (predictions: IElementPrediction[]) => [...predictions].sort((a, b) => a.classId - b.classId);

describe('semantic score grid', () => {
  it.each([0.3, 0.5, 0.7, 0.9])('rebuilds the same mask, box and mean confidence as inference at %s', threshold => {
    const { scoreGrid } = run(MIN_SCORE_THRESHOLD, true);
    const direct = byClass(run(threshold).predictions);
    const rebuilt = byClass(predictionsFromScoreGrid(scoreGrid!, threshold));

    expect(direct.length).toBeGreaterThan(0);

    expect(rebuilt.map(p => p.classId)).toEqual(direct.map(p => p.classId));
    rebuilt.forEach((prediction, index) => {
      const expected = direct[index]!;
      expect(prediction.className).toBe(expected.className);
      expect(prediction.masks).toEqual(expected.masks);
      expect(prediction.boundingBox).toEqual(expected.boundingBox);
      expect(prediction.probability).toBeCloseTo(expected.probability, 2);
    });
  });

  it('keeps only target classes', () => {
    const { scoreGrid } = run(MIN_SCORE_THRESHOLD, true);
    const classNames = predictionsFromScoreGrid(scoreGrid!, MIN_SCORE_THRESHOLD).map(p => p.className);
    expect(classNames.sort()).toEqual(['breast', 'genitals']);
  });

  it('yields no predictions above the top unsafe score', () => {
    const { scoreGrid, topUnsafeScore } = run(MIN_SCORE_THRESHOLD, true);
    expect(predictionsFromScoreGrid(scoreGrid!, Math.min(topUnsafeScore + 0.01, 1))).toEqual([]);
  });

  it('is only built on request', () => {
    expect(run(0.5).scoreGrid).toBeUndefined();
  });
});
