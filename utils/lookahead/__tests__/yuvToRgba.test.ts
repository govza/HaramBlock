import { describe, expect, it } from 'vitest';

import { i420ToRgba, modelInputSize } from '@/utils/lookahead/yuvToRgba';

function solidFrame(width: number, height: number, [y, u, v]: readonly [number, number, number]) {
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const heap = new Uint8Array(width * height + 2 * chromaWidth * chromaHeight);
  heap.fill(y, 0, width * height);
  heap.fill(u, width * height, width * height + chromaWidth * chromaHeight);
  heap.fill(v, width * height + chromaWidth * chromaHeight);
  return {
    heap,
    width,
    height,
    planes: [0, width * height, width * height + chromaWidth * chromaHeight] as const,
    strides: [width, chromaWidth, chromaWidth] as const,
  };
}

const firstPixel = (data: Uint8ClampedArray) => [...data.slice(0, 4)];

describe('i420ToRgba', () => {
  it('downscales to the model input size, keeping aspect', () => {
    expect(modelInputSize(1280, 720, 640)).toEqual({ width: 640, height: 360 });
    expect(modelInputSize(320, 180, 640)).toEqual({ width: 320, height: 180 });
    const image = i420ToRgba(solidFrame(64, 36, [128, 128, 128]), 32);
    expect([image.width, image.height]).toEqual([32, 18]);
    expect(image.data).toHaveLength(32 * 18 * 4);
  });

  it('maps limited-range black, white and red', () => {
    expect(firstPixel(i420ToRgba(solidFrame(4, 4, [16, 128, 128]), 4).data)).toEqual([0, 0, 0, 255]);
    expect(firstPixel(i420ToRgba(solidFrame(4, 4, [235, 128, 128]), 4).data)).toEqual([255, 255, 255, 255]);
    const [r, g, b] = firstPixel(i420ToRgba(solidFrame(4, 4, [63, 102, 240]), 4).data);
    expect(r).toBeGreaterThan(240);
    expect(g).toBeLessThan(20);
    expect(b).toBeLessThan(20);
  });
});
