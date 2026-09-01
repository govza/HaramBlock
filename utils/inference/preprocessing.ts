import { getLogger } from '@/utils/telemetry';

import type { ModelMetadata } from '@/utils/types';

const log = getLogger('preprocessing');

export async function loadImageBitmap(imageSrc: string): Promise<{
  imageBitmap: ImageBitmap;
  fetchTime: number;
  decodeTime: number;
}> {
  try {
    const fetchStartTime = Date.now();
    const blob = await fetchImageBlob(imageSrc);
    const fetchTime = Date.now() - fetchStartTime;

    const decodeStartTime = Date.now();
    const imageBitmap = await createBitmapFromBlob(blob);
    const decodeTime = Date.now() - decodeStartTime;

    log.debug('preprocess.image.loaded', { src: imageSrc, fetchMs: fetchTime, decodeMs: decodeTime });

    return { imageBitmap, fetchTime, decodeTime };
  } catch (error) {
    log.error('preprocess.image.load_failed', { src: imageSrc, error });
    throw new Error(`Failed to load image from ${imageSrc.substring(0, 50)}...`, { cause: error });
  }
}

async function fetchImageBlob(imageSrc: string): Promise<Blob> {
  log.debug('preprocess.image.fetching', { src: imageSrc });

  const response = await fetch(imageSrc, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }
  return response.blob();
}

async function createBitmapFromBlob(blob: Blob): Promise<ImageBitmap> {
  log.debug('preprocess.bitmap.creating');
  return createImageBitmap(blob);
}

/**
 * Converts ImageBitmap to NCHW Float32Array for model inference.
 * Maintains aspect ratio via letterboxing (gray padding for YOLO, black for ImageNet).
 * Supports both ImageNet normalization (mean/std) and YOLO-style (0-1) normalization.
 *
 * @param imageBitmap The image to convert
 * @param config Model configuration with imgsz and normalize params
 * @returns Float32Array in NCHW format [1, 3, height, width]
 */
export function preprocessImage(imageBitmap: ImageBitmap, config: ModelMetadata): Float32Array {
  const [modelHeight, modelWidth] = config.imgsz;
  const { normalize } = config;

  // Calculate letterbox dimensions (matching postprocessing for consistency)
  const scale = Math.min(modelWidth / imageBitmap.width, modelHeight / imageBitmap.height);
  const newWidth = Math.round(imageBitmap.width * scale);
  const newHeight = Math.round(imageBitmap.height * scale);
  // Keep offset as float, round for canvas positioning (matches Python reference)
  const offsetX = (modelWidth - newWidth) / 2;
  const offsetY = (modelHeight - newHeight) / 2;

  // Create offscreen canvas and draw letterboxed image
  const canvas = new OffscreenCanvas(modelWidth, modelHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }

  // Fill with gray (114/255 ≈ 0.447) for YOLO letterbox padding
  ctx.fillStyle = normalize ? 'black' : 'rgb(114, 114, 114)';
  ctx.fillRect(0, 0, modelWidth, modelHeight);

  // Draw scaled image centered
  ctx.drawImage(imageBitmap, offsetX, offsetY, newWidth, newHeight);

  // Get pixel data
  const imageData = ctx.getImageData(0, 0, modelWidth, modelHeight);
  const pixels = imageData.data; // RGBA format

  // Create NCHW tensor [1, 3, H, W]
  const tensorData = new Float32Array(1 * 3 * modelHeight * modelWidth);
  const channelStride = modelHeight * modelWidth;

  if (normalize) {
    // ImageNet-style normalization: (pixel/255 - mean) / std
    const { mean, std } = normalize;
    for (let y = 0; y < modelHeight; y++) {
      for (let x = 0; x < modelWidth; x++) {
        const pixelIndex = (y * modelWidth + x) * 4;
        const spatialIndex = y * modelWidth + x;

        const r = pixels[pixelIndex] ?? 0;
        const g = pixels[pixelIndex + 1] ?? 0;
        const b = pixels[pixelIndex + 2] ?? 0;

        tensorData[spatialIndex] = (r / 255 - mean[0]) / std[0];
        tensorData[channelStride + spatialIndex] = (g / 255 - mean[1]) / std[1];
        tensorData[2 * channelStride + spatialIndex] = (b / 255 - mean[2]) / std[2];
      }
    }
  } else {
    // YOLO-style normalization: pixel / 255 (0-1 range)
    for (let y = 0; y < modelHeight; y++) {
      for (let x = 0; x < modelWidth; x++) {
        const pixelIndex = (y * modelWidth + x) * 4;
        const spatialIndex = y * modelWidth + x;

        const r = pixels[pixelIndex] ?? 0;
        const g = pixels[pixelIndex + 1] ?? 0;
        const b = pixels[pixelIndex + 2] ?? 0;

        tensorData[spatialIndex] = r / 255;
        tensorData[channelStride + spatialIndex] = g / 255;
        tensorData[2 * channelStride + spatialIndex] = b / 255;
      }
    }
  }

  return tensorData;
}
