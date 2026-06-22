import { describe, expect, it } from 'vitest';

import {
  MAX_SCORE_THRESHOLD,
  MIN_SCORE_THRESHOLD,
  strictnessToScoreThreshold,
} from '@/entrypoints/background/modelUtils/scoreThreshold';

describe('strictnessToScoreThreshold', () => {
  it('maps minimum strictness to the most permissive (highest) threshold', () => {
    expect(strictnessToScoreThreshold(0)).toBe(MAX_SCORE_THRESHOLD);
  });

  it('maps maximum strictness to the strictest (lowest) threshold', () => {
    expect(strictnessToScoreThreshold(1)).toBe(MIN_SCORE_THRESHOLD);
  });

  it('passes mid-range strictness through as 1 - strictness', () => {
    expect(strictnessToScoreThreshold(0.5)).toBeCloseTo(0.5, 10);
    expect(strictnessToScoreThreshold(0.3)).toBeCloseTo(0.7, 10);
  });

  it('clamps to the upper bound just inside the low-strictness edge', () => {
    // 1 - 0.05 = 0.95, clamped down to 0.9.
    expect(strictnessToScoreThreshold(0.05)).toBe(MAX_SCORE_THRESHOLD);
    // 1 - 0.1 = 0.9 sits exactly on the bound.
    expect(strictnessToScoreThreshold(0.1)).toBe(MAX_SCORE_THRESHOLD);
    // 1 - 0.11 = 0.89 stays just inside the bound.
    expect(strictnessToScoreThreshold(0.11)).toBeCloseTo(0.89, 10);
  });

  it('clamps to the lower bound just inside the high-strictness edge', () => {
    // 1 - 0.95 lands a hair above 0.05 in floating point, so it passes through unclamped.
    expect(strictnessToScoreThreshold(0.95)).toBeCloseTo(0.05, 10);
    // 1 - 0.99 = 0.01, clearly below the bound, so it clamps up to exactly 0.05.
    expect(strictnessToScoreThreshold(0.99)).toBe(MIN_SCORE_THRESHOLD);
    // 1 - 0.94 = 0.06 stays just inside the bound.
    expect(strictnessToScoreThreshold(0.94)).toBeCloseTo(0.06, 10);
  });

  it('clamps out-of-range strictness instead of extrapolating', () => {
    expect(strictnessToScoreThreshold(-1)).toBe(MAX_SCORE_THRESHOLD);
    expect(strictnessToScoreThreshold(2)).toBe(MIN_SCORE_THRESHOLD);
  });

  it('propagates NaN strictness (settings are always valid numbers, so this only documents the math)', () => {
    expect(strictnessToScoreThreshold(NaN)).toBeNaN();
  });

  it('keeps the bounds ordered and inside the probability range', () => {
    expect(MIN_SCORE_THRESHOLD).toBeLessThan(MAX_SCORE_THRESHOLD);
    expect(MIN_SCORE_THRESHOLD).toBeGreaterThan(0);
    expect(MAX_SCORE_THRESHOLD).toBeLessThan(1);
  });
});
