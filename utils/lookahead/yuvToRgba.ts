/**
 * One decoded 8-bit 4:2:0 frame as three planes in decoder memory.
 */
export interface I420Frame {
  heap: Uint8Array;
  width: number;
  height: number;
  planes: readonly [number, number, number];
  strides: readonly [number, number, number];
}

/**
 * An RGBA image at model input size, ready for `new ImageData(...)`.
 */
export interface RgbaImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

export function modelInputSize(width: number, height: number, inputSize: number): { width: number; height: number } {
  const scale = Math.min(1, inputSize / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const clampByte = (value: number): number => {
  if (value < 0) return 0;
  return value > 255 ? 255 : value;
};

/**
 * Nearest-neighbour downscale and BT.709 limited-range YUV to RGB conversion in one pass.
 */
export function i420ToRgba(frame: I420Frame, inputSize: number): RgbaImage {
  const { width, height } = modelInputSize(frame.width, frame.height, inputSize);
  const data = new Uint8ClampedArray(width * height * 4);
  const [yPlane, uPlane, vPlane] = frame.planes;
  const [yStride, uStride, vStride] = frame.strides;
  const { heap } = frame;
  const sourceColumns = Array.from({ length: width }, (_, x) =>
    Math.min(frame.width - 1, Math.floor(((x + 0.5) * frame.width) / width)),
  );
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(frame.height - 1, Math.floor(((y + 0.5) * frame.height) / height));
    const yRow = yPlane + sourceY * yStride;
    const uRow = uPlane + (sourceY >> 1) * uStride;
    const vRow = vPlane + (sourceY >> 1) * vStride;
    for (let x = 0; x < width; x++) {
      const sourceX = sourceColumns[x] ?? 0;
      const luma = 1.164 * ((heap[yRow + sourceX] ?? 0) - 16);
      const u = (heap[uRow + (sourceX >> 1)] ?? 0) - 128;
      const v = (heap[vRow + (sourceX >> 1)] ?? 0) - 128;
      const offset = (y * width + x) * 4;
      data[offset] = clampByte(luma + 1.793 * v);
      data[offset + 1] = clampByte(luma - 0.213 * u - 0.533 * v);
      data[offset + 2] = clampByte(luma + 2.112 * u);
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}
