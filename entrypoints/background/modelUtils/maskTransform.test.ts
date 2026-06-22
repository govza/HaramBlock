import { describe, expect, it } from 'vitest';

import { calculateLetterboxParams, calculateScaleFactors } from '@/entrypoints/background/modelUtils/maskTransform';

describe('calculateScaleFactors', () => {
  it('produces an identity transform for a square image at model size', () => {
    expect(calculateScaleFactors(640, 640, 640, 640)).toEqual({
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('letterboxes vertically for a wide image (offset on Y only)', () => {
    // scale = min(640/1280, 640/640) = 0.5 -> scaled 640x320, padded 160px top & bottom.
    expect(calculateScaleFactors(1280, 640, 640, 640)).toEqual({
      scaleX: 2,
      scaleY: 2,
      offsetX: 0,
      offsetY: 160,
    });
  });

  it('letterboxes horizontally for a tall image (offset on X only)', () => {
    expect(calculateScaleFactors(640, 1280, 640, 640)).toEqual({
      scaleX: 2,
      scaleY: 2,
      offsetX: 160,
      offsetY: 0,
    });
  });

  it('upscales a tiny image', () => {
    // scale = min(640/2, 640/1) = 320 -> scaled 640x320, padded 160px top & bottom.
    expect(calculateScaleFactors(2, 1, 640, 640)).toEqual({
      scaleX: 2 / 640,
      scaleY: 1 / 320,
      offsetX: 0,
      offsetY: 160,
    });
  });

  it('handles an extreme wide aspect ratio with rounded scaled height', () => {
    // scale = 0.64 -> scaledHeight = round(10 * 0.64) = round(6.4) = 6, offsetY = (640 - 6) / 2 = 317.
    const result = calculateScaleFactors(1000, 10, 640, 640);
    expect(result.offsetX).toBe(0);
    expect(result.offsetY).toBe(317);
    expect(result.scaleX).toBeCloseTo(1000 / 640, 10);
    expect(result.scaleY).toBeCloseTo(10 / 6, 10);
  });

  it('keeps the letterbox offset as a float (matches Python YOLO reference)', () => {
    // scaledHeight = round(640 * (640/641)) = round(639.0...) = 639 -> offsetY = (640 - 639) / 2 = 0.5.
    const result = calculateScaleFactors(641, 640, 640, 640);
    expect(result.offsetY).toBe(0.5);
  });
});

describe('calculateLetterboxParams', () => {
  it('crops nothing when the image already fills the model square', () => {
    const result = calculateLetterboxParams(640, 640, 640, 640, 160, 160);
    expect(result).toMatchObject({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      protoOffsetX: 0,
      protoOffsetY: 0,
      contentProtoWidth: 160,
      contentProtoHeight: 160,
    });
  });

  it('crops the vertical letterbox out of prototype space for a wide image', () => {
    // offsetY = 160 input px -> 40 proto rows removed top & bottom (stride = 640/160 = 4).
    const result = calculateLetterboxParams(1280, 640, 640, 640, 160, 160);
    expect(result).toMatchObject({
      scale: 0.5,
      offsetX: 0,
      offsetY: 160,
      protoOffsetX: 0,
      protoOffsetY: 40,
      contentProtoWidth: 160,
      contentProtoHeight: 80,
    });
  });

  it('crops the horizontal letterbox out of prototype space for a tall image', () => {
    const result = calculateLetterboxParams(640, 1280, 640, 640, 160, 160);
    expect(result).toMatchObject({
      scale: 0.5,
      offsetX: 160,
      offsetY: 0,
      protoOffsetX: 40,
      protoOffsetY: 0,
      contentProtoWidth: 80,
      contentProtoHeight: 160,
    });
  });

  it('uses the full prototype grid when a tiny image is upscaled to fill the square', () => {
    const result = calculateLetterboxParams(4, 4, 640, 640, 160, 160);
    expect(result.contentProtoWidth).toBe(160);
    expect(result.contentProtoHeight).toBe(160);
  });
});
