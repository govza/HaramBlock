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
 * Encode a flat binary mask buffer to RLE format.
 * @param data - Flat Uint8Array of 0s and 1s in row-major order
 * @param width - Width of the mask
 * @param height - Height of the mask
 * @returns RLE-encoded mask
 */
export function encodeMaskRLE(data: Uint8Array, width: number, height: number): IRLEMask {
  const totalSize = width * height;
  if (totalSize === 0 || data.length < totalSize) {
    return { width: 0, height: 0, startValue: 0, runs: [] };
  }

  const runs: number[] = [];
  let currentValue = data[0] ? 1 : 0;
  const startValue = currentValue as 0 | 1;
  let runLength = 0;

  for (let i = 0; i < totalSize; i++) {
    const value = data[i] ? 1 : 0;
    if (value === currentValue) {
      runLength++;
    } else {
      runs.push(runLength);
      currentValue = value;
      runLength = 1;
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
