import { describe, expect, it } from 'vitest';

import { decodeMaskRLE, encodeMaskRLE, type IRLEMask } from '@/utils/rle';

function flatten(mask: number[][]): number[] {
  return mask.flat();
}

function randomMask(width: number, height: number, seed: number): Uint8Array {
  // Deterministic pseudo-random fill so the round-trip test is reproducible.
  const data = new Uint8Array(width * height);
  let state = seed;
  for (let i = 0; i < data.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (state >> 16) & 1;
  }
  return data;
}

describe('encodeMaskRLE', () => {
  it('encodes a fully-zero mask as a single run starting at 0', () => {
    const data = new Uint8Array(4 * 3); // all zeros
    expect(encodeMaskRLE(data, 4, 3)).toEqual<IRLEMask>({
      width: 4,
      height: 3,
      startValue: 0,
      runs: [12],
    });
  });

  it('encodes a fully-one mask as a single run starting at 1', () => {
    const data = new Uint8Array(4 * 3).fill(1);
    expect(encodeMaskRLE(data, 4, 3)).toEqual<IRLEMask>({
      width: 4,
      height: 3,
      startValue: 1,
      runs: [12],
    });
  });

  it('alternates runs and always pushes the final run', () => {
    // 0 0 1 1 1 0 -> runs [2, 3, 1] starting at 0
    const data = Uint8Array.from([0, 0, 1, 1, 1, 0]);
    expect(encodeMaskRLE(data, 6, 1)).toEqual<IRLEMask>({
      width: 6,
      height: 1,
      startValue: 0,
      runs: [2, 3, 1],
    });
  });

  it('treats any non-zero byte as 1', () => {
    const data = Uint8Array.from([5, 0, 200]);
    expect(encodeMaskRLE(data, 3, 1)).toEqual<IRLEMask>({
      width: 3,
      height: 1,
      startValue: 1,
      runs: [1, 1, 1],
    });
  });

  it('encodes a single-pixel mask', () => {
    expect(encodeMaskRLE(Uint8Array.from([1]), 1, 1)).toEqual<IRLEMask>({
      width: 1,
      height: 1,
      startValue: 1,
      runs: [1],
    });
  });

  it('returns an empty mask when dimensions are zero', () => {
    expect(encodeMaskRLE(new Uint8Array(0), 0, 0)).toEqual<IRLEMask>({
      width: 0,
      height: 0,
      startValue: 0,
      runs: [],
    });
  });

  it('returns an empty mask when the buffer is smaller than width * height', () => {
    expect(encodeMaskRLE(Uint8Array.from([1, 0]), 4, 4)).toEqual<IRLEMask>({
      width: 0,
      height: 0,
      startValue: 0,
      runs: [],
    });
  });

  it('ignores trailing bytes beyond width * height', () => {
    const data = Uint8Array.from([1, 1, 0, 0, 9, 9]); // only first 4 belong to a 2x2 mask
    expect(encodeMaskRLE(data, 2, 2)).toEqual<IRLEMask>({
      width: 2,
      height: 2,
      startValue: 1,
      runs: [2, 2],
    });
  });
});

describe('decodeMaskRLE', () => {
  it('decodes runs row by row into a 2D array', () => {
    const rle: IRLEMask = { width: 3, height: 2, startValue: 0, runs: [2, 3, 1] };
    expect(decodeMaskRLE(rle)).toEqual([
      [0, 0, 1],
      [1, 1, 0],
    ]);
  });

  it('returns an empty array for zero width', () => {
    expect(decodeMaskRLE({ width: 0, height: 2, startValue: 1, runs: [4] })).toEqual([]);
  });

  it('returns an empty array for zero height', () => {
    expect(decodeMaskRLE({ width: 2, height: 0, startValue: 1, runs: [4] })).toEqual([]);
  });

  it('returns an empty array when there are no runs', () => {
    expect(decodeMaskRLE({ width: 2, height: 2, startValue: 0, runs: [] })).toEqual([]);
  });
});

describe('RLE round-trip', () => {
  it('encode -> decode reproduces the original mask', () => {
    const width = 16;
    const height = 10;
    const original = randomMask(width, height, 42);

    const decoded = decodeMaskRLE(encodeMaskRLE(original, width, height));

    expect(flatten(decoded)).toEqual(Array.from(original));
  });

  it('round-trips a single-pixel mask', () => {
    const decoded = decodeMaskRLE(encodeMaskRLE(Uint8Array.from([1]), 1, 1));
    expect(decoded).toEqual([[1]]);
  });

  it('round-trips a mask whose final run reaches the last pixel', () => {
    // Ends on a 1-run so the "push the final run" path carries the last pixel.
    const data = Uint8Array.from([0, 0, 0, 1]);
    const decoded = decodeMaskRLE(encodeMaskRLE(data, 2, 2));
    expect(flatten(decoded)).toEqual([0, 0, 0, 1]);
  });

  it('round-trips an all-zero and an all-one mask', () => {
    const zeros = new Uint8Array(6 * 6);
    const ones = new Uint8Array(6 * 6).fill(1);

    expect(flatten(decodeMaskRLE(encodeMaskRLE(zeros, 6, 6)))).toEqual(Array.from(zeros));
    expect(flatten(decodeMaskRLE(encodeMaskRLE(ones, 6, 6)))).toEqual(Array.from(ones));
  });
});
