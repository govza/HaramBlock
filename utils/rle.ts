/**
 * Run-Length Encoding utilities for binary mask compression.
 *
 * Binary masks (160x160 = 25,600 elements) compress extremely well with RLE
 * since they're sparse (mostly 0s with small regions of 1s).
 *
 * Format: { width, height, startValue, runs[] }
 * - Flatten 2D array row by row
 * - Store consecutive run lengths, alternating between startValue and !startValue
 */

export interface IRLEMask {
  width: number;
  height: number;
  startValue: 0 | 1;
  runs: number[];
}

/**
 * Encode a 2D binary mask to RLE format.
 * @param mask - 2D array of 0s and 1s [height][width]
 * @returns RLE-encoded mask
 */
export function encodeMaskRLE(mask: number[][]): IRLEMask {
  const height = mask.length;
  const width = mask[0]?.length || 0;

  const firstRow = mask[0];
  if (height === 0 || width === 0 || !firstRow) {
    return { width: 0, height: 0, startValue: 0, runs: [] };
  }

  const runs: number[] = [];
  let currentValue = firstRow[0] ? 1 : 0;
  const startValue = currentValue as 0 | 1;
  let runLength = 0;

  for (let y = 0; y < height; y++) {
    const row = mask[y];
    if (!row) continue;
    for (let x = 0; x < width; x++) {
      const value = row[x] ? 1 : 0;
      if (value === currentValue) {
        runLength++;
      } else {
        runs.push(runLength);
        currentValue = value;
        runLength = 1;
      }
    }
  }

  // Push the final run
  runs.push(runLength);

  return { width, height, startValue, runs };
}

/**
 * Decode an RLE-encoded mask back to 2D array format.
 * @param rle - RLE-encoded mask
 * @returns 2D array of 0s and 1s [height][width]
 */
export function decodeMaskRLE(rle: IRLEMask): number[][] {
  const { width, height, startValue, runs } = rle;

  if (width === 0 || height === 0 || runs.length === 0) {
    return [];
  }

  // Pre-allocate the 2D array
  const mask: number[][] = [];
  for (let y = 0; y < height; y++) {
    mask[y] = new Array<number>(width).fill(0);
  }

  let currentValue = startValue;
  let x = 0;
  let y = 0;

  for (const runLength of runs) {
    for (let i = 0; i < runLength; i++) {
      const row = mask[y];
      if (row) {
        row[x] = currentValue;
      }
      x++;
      if (x >= width) {
        x = 0;
        y++;
      }
    }
    // Alternate between 0 and 1
    currentValue = currentValue === 0 ? 1 : 0;
  }

  return mask;
}
