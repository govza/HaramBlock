import { describe, expect, it } from 'vitest';

import { gifInferenceFrameCap, sampleFrameIndices } from '@/entrypoints/content/gif/gifDecoder';

describe('sampleFrameIndices', () => {
  it('returns every frame when total is within the cap', () => {
    expect(sampleFrameIndices(5, 8)).toEqual([0, 1, 2, 3, 4]);
    expect(sampleFrameIndices(8, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns an empty list for non-positive totals', () => {
    expect(sampleFrameIndices(0, 8)).toEqual([]);
    expect(sampleFrameIndices(-3, 8)).toEqual([]);
  });

  it('always includes the first and last frame', () => {
    const indices = sampleFrameIndices(100, 8);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(99);
  });

  it('samples evenly and never exceeds the cap', () => {
    const indices = sampleFrameIndices(100, 8);
    expect(indices.length).toBeLessThanOrEqual(8);
    expect(indices).toEqual([0, 14, 28, 42, 57, 71, 85, 99]);
  });

  it('returns sorted, de-duplicated indices', () => {
    const indices = sampleFrameIndices(10, 8);
    const sortedUnique = [...new Set(indices)].sort((a, b) => a - b);
    expect(indices).toEqual(sortedUnique);
  });
});

describe('gifInferenceFrameCap', () => {
  it('is zero for non-positive counts', () => {
    expect(gifInferenceFrameCap(0)).toBe(0);
    expect(gifInferenceFrameCap(-5)).toBe(0);
  });

  it('clamps short GIFs to the floor', () => {
    expect(gifInferenceFrameCap(1)).toBe(6);
    expect(gifInferenceFrameCap(6)).toBe(6);
    expect(gifInferenceFrameCap(18)).toBe(6);
  });

  it('scales with frame count between the bounds', () => {
    expect(gifInferenceFrameCap(24)).toBe(8);
    expect(gifInferenceFrameCap(72)).toBe(24);
  });

  it('clamps long GIFs to the ceiling', () => {
    expect(gifInferenceFrameCap(73)).toBe(24);
    expect(gifInferenceFrameCap(300)).toBe(24);
  });

  it('never exceeds the frame count once paired with sampling', () => {
    for (const total of [1, 5, 12, 40, 100, 300]) {
      const sampled = sampleFrameIndices(total, gifInferenceFrameCap(total));
      expect(sampled.length).toBeLessThanOrEqual(total);
      expect(sampled.length).toBeLessThanOrEqual(24);
    }
  });
});
