import * as tf from '@tensorflow/tfjs';

import { logger, extractUrlId } from '@/utils/logger';

export async function loadImageBitmap(imageSrc: string): Promise<{
  imageBitmap: ImageBitmap;
  fetchTime: number;
  bitmapTime: number;
}> {
  try {
    const fetchStartTime = Date.now();
    const blob = await fetchImageBlob(imageSrc);
    const fetchTime = Date.now() - fetchStartTime;

    const bitmapStartTime = Date.now();
    const imageBitmap = await createBitmapFromBlob(blob);
    const bitmapTime = Date.now() - bitmapStartTime;

    logger
      .withTag('imageProcessor')
      .debug(
        `Successfully loaded image from: ${extractUrlId(imageSrc)}... (fetch: ${fetchTime}ms, bitmap: ${bitmapTime}ms)`,
      );

    return { imageBitmap, fetchTime, bitmapTime };
  } catch (error) {
    logger.withTag('imageProcessor').error('Failed to load image:', error);
    throw new Error(`Failed to load image from ${imageSrc.substring(0, 50)}...`, { cause: error });
  }
}

async function fetchImageBlob(imageSrc: string): Promise<Blob> {
  logger.withTag('imageProcessor').debug('Fetching image');

  const response = await fetch(imageSrc, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }
  return response.blob();
}

async function createBitmapFromBlob(blob: Blob): Promise<ImageBitmap> {
  logger.withTag('imageProcessor').debug('Creating bitmap from blob');
  return createImageBitmap(blob);
}

export function getImageDimensions(imageBitmap: ImageBitmap): {
  width: number;
  height: number;
} {
  return {
    width: imageBitmap.width,
    height: imageBitmap.height,
  };
}

/**
 * Converts ImageBitmap to Canvas with proper aspect ratio and padding
 * Maintains aspect ratio while resizing and fills missing areas with black
 * @param imageBitmap The image to convert
 * @param imgsz Target size [width, height] from YOLO metadata
 * @returns Canvas element ready for TensorFlow processing
 */
export function convertImageToCanvas(
  imageBitmap: ImageBitmap,
  originalSize: [number, number],
  imgsz: [number, number],
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(imgsz[0], imgsz[1]);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas context is not available');
  }

  const originalWidth = originalSize[0] || imageBitmap.width;
  const originalHeight = originalSize[1] || imageBitmap.height;

  const scale = Math.min(imgsz[0] / originalWidth, imgsz[1] / originalHeight);

  const newWidth = originalWidth * scale;
  const newHeight = originalHeight * scale;

  // Fill with black background
  context.fillStyle = 'black';
  context.fillRect(0, 0, imgsz[0], imgsz[1]);

  // Draw resized image (centered)
  const offsetX = (imgsz[0] - newWidth) / 2;
  const offsetY = (imgsz[1] - newHeight) / 2;
  context.drawImage(imageBitmap, offsetX, offsetY, newWidth, newHeight);

  return canvas;
}

/**
 * Converts ImageBitmap to TensorFlow tensor with proper preprocessing
 * using TF ops (no canvas). Maintains aspect ratio via letterboxing
 * to match the model's expected [width, height].
 * @param imageBitmap The image to convert
 * @param imgsz Target size [width, height] from YOLO metadata
 * @returns TensorFlow tensor [1, height, width, 3] normalized to [0,1]
 */
export function tensorFromImageBitmap(imageBitmap: ImageBitmap, imgsz: [number, number]): tf.Tensor4D {
  const [modelW, modelH] = imgsz;

  return tf.tidy(() => {
    // 1) Create tensor directly from ImageBitmap and normalize
    const img: tf.Tensor3D = tf.browser.fromPixels(imageBitmap).toFloat().div(255);

    const [h, w] = img.shape;
    const scale = Math.min(modelW / w, modelH / h);
    const newW = Math.max(1, Math.round(w * scale));
    const newH = Math.max(1, Math.round(h * scale));

    // 2) Aspect-preserving resize
    const resized: tf.Tensor3D = tf.image.resizeBilinear(img, [newH, newW], true);

    // 3) Letterbox to target size with black padding
    const padLeft = Math.floor((modelW - newW) / 2);
    const padRight = modelW - newW - padLeft;
    const padTop = Math.floor((modelH - newH) / 2);
    const padBottom = modelH - newH - padTop;

    const padded: tf.Tensor3D = tf.pad(resized, [
      [padTop, padBottom],
      [padLeft, padRight],
      [0, 0],
    ]);

    // 4) Add batch dimension
    return padded.expandDims(0);
  });
}
