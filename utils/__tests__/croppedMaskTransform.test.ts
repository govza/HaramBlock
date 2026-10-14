import { describe, expect, it } from 'vitest';

import { croppedMaskTransform } from '@/utils/croppedMaskTransform';

import type { IElementPrediction } from '@/utils/types';

const withMask = (width: number, height: number): IElementPrediction => ({
  classId: 0,
  className: 'unsafe',
  probability: 0.9,
  boundingBox: { x: 0, y: 0, width, height },
  masks: { width, height, startValue: 1, runs: [width * height] },
});

describe('croppedMaskTransform', () => {
  it('scales the first mask grid onto the image with no letterbox offset', () => {
    expect(croppedMaskTransform([withMask(160, 90)], 640, 360)).toEqual({
      scaleX: 4,
      scaleY: 4,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('falls back to a one-cell grid when no prediction has a mask', () => {
    expect(croppedMaskTransform([], 640, 360)).toEqual({ scaleX: 640, scaleY: 360, offsetX: 0, offsetY: 0 });
  });
});
