import { describe, expect, it } from 'vitest';

import { isUnsafeAt, predictionsAt, rawScoresOf, suspicionThresholdOf } from '@/utils/lookahead/sampleScores';
import { encodeScoreGrid } from '@/utils/scoreGrid';

import type { InferredSample } from '@/utils/lookahead/ports';
import type { IElementPrediction } from '@/utils/types';

const INPUT = { width: 100, height: 100, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } };

const detection = (probability: number): IElementPrediction => ({
  classId: 1,
  className: 'breast',
  probability,
  boundingBox: { x: 40, y: 40, width: 20, height: 20 },
  masks: { width: 1, height: 1, startValue: 1, runs: [1] },
});

const detectionsSample = (...probabilities: number[]): InferredSample => ({
  scores: { kind: 'detections', detections: probabilities.map(detection) },
  input: INPUT,
  topUnsafeScore: Math.max(0, ...probabilities),
});

const gridSample = (): InferredSample => ({
  scores: {
    kind: 'grid',
    grid: encodeScoreGrid(
      { width: 2, height: 1, cellWidth: 50, cellHeight: 100 },
      Uint8Array.of(51, 204),
      Uint8Array.of(1, 1),
      { 1: 'breast' },
    ),
  },
  input: INPUT,
  topUnsafeScore: 0.8,
});

describe('predictionsAt', () => {
  it('keeps the detections at or above the reader threshold', () => {
    const sample = detectionsSample(0.1, 0.5, 0.8);
    expect(predictionsAt(sample, 0.5).map(p => p.probability)).toEqual([0.5, 0.8]);
    expect(predictionsAt(sample, 0.9)).toEqual([]);
  });

  it('rebuilds a semantic grid under the reader threshold', () => {
    const [strict] = predictionsAt(gridSample(), 0.1);
    const [lenient] = predictionsAt(gridSample(), 0.5);
    expect(strict?.masks.runs).toEqual([2]);
    expect(strict?.probability).toBeCloseTo(0.5);
    expect(lenient?.masks).toEqual({ width: 2, height: 1, startValue: 0, runs: [1, 1] });
    expect(lenient?.probability).toBeCloseTo(0.8);
  });

  it('snaps rebuilt boxes near the frame edge to it, like inference does', () => {
    const [prediction] = predictionsAt(gridSample(), 0.5);
    expect(prediction?.boundingBox).toEqual({ x: 50, y: 0, width: 50, height: 100 });
  });
});

describe('isUnsafeAt', () => {
  it('follows the reader threshold', () => {
    expect(isUnsafeAt(detectionsSample(0.4), 0.3)).toBe(true);
    expect(isUnsafeAt(detectionsSample(0.4), 0.5)).toBe(false);
    expect(isUnsafeAt(gridSample(), 0.9)).toBe(false);
  });
});

describe('suspicionThresholdOf', () => {
  it('is half the reader threshold, with no floor', () => {
    expect(suspicionThresholdOf(0.5)).toBe(0.25);
    expect(suspicionThresholdOf(0.05)).toBe(0.025);
  });
});

describe('rawScoresOf', () => {
  it('prefers the semantic grid over floor detections', () => {
    const grid = gridSample().scores;
    if (grid.kind !== 'grid') throw new Error('expected grid');
    expect(rawScoresOf({ predictions: [detection(0.2)], scoreGrid: grid.grid })).toEqual(grid);
    expect(rawScoresOf({ predictions: [detection(0.2)] })).toEqual({
      kind: 'detections',
      detections: [detection(0.2)],
    });
  });
});
