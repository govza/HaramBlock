import { describe, expect, it } from 'vitest';

import { maskClipPath } from '@/entrypoints/content/video/presenter/maskClipPath';

import type { VerdictEntry } from '@/entrypoints/content/video/timeline/verdictTimeline';
import type { IRLEMask } from '@/utils/rle';

function entryWith(...masks: IRLEMask[]): VerdictEntry {
  return {
    timestampSec: 0,
    unsafe: true,
    width: 2,
    height: 2,
    maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    predictions: masks.map(mask => ({
      classId: 0,
      className: 'unsafe',
      probability: 0.9,
      boundingBox: { x: 0, y: 0, width: 2, height: 2 },
      masks: mask,
    })),
  };
}

const CONTENT = { offsetX: 10, offsetY: 0, width: 100, height: 100 };

describe('mask clip path', () => {
  it('maps mask cells onto the rendered content rectangle', () => {
    const path = maskClipPath([entryWith({ width: 2, height: 2, startValue: 1, runs: [1, 3] })], CONTENT);
    expect(path).toBe('M10 0H60V50H10Z');
  });

  it('merges a cell column spanning rows into one rectangle', () => {
    const path = maskClipPath([entryWith({ width: 2, height: 2, startValue: 0, runs: [1, 1, 1, 1] })], CONTENT);
    expect(path).toBe('M60 0H110V100H60Z');
  });

  it('unions the masks of every covering verdict', () => {
    const topLeft = entryWith({ width: 2, height: 2, startValue: 1, runs: [1, 3] });
    const bottomRight = entryWith({ width: 2, height: 2, startValue: 0, runs: [3, 1] });
    expect(maskClipPath([topLeft, bottomRight], CONTENT)).toBe('M10 0H60V50H10ZM60 50H110V100H60Z');
  });

  it('returns null when no cell is masked', () => {
    expect(maskClipPath([entryWith({ width: 2, height: 2, startValue: 0, runs: [4] })], CONTENT)).toBeNull();
  });
});
