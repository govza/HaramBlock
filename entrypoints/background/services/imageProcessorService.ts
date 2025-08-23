import * as tf from '@tensorflow/tfjs';

import { logger, extractUrlId } from '@/utils/logger';

export class ImageProcessorService {
  async loadImageBitmap(imageSrc: string): Promise<ImageBitmap> {
    try {
      let imageBitmap: ImageBitmap;

      if (imageSrc.startsWith('blob:')) {
        imageBitmap = await this.loadBlobImage(imageSrc);
      } else if (imageSrc.startsWith('data:')) {
        imageBitmap = await this.loadDataUrlImage(imageSrc);
      } else if (imageSrc.startsWith('http://') || imageSrc.startsWith('https://')) {
        imageBitmap = await this.loadUrlImage(imageSrc);
      } else {
        throw new Error(`Unsupported image source type: ${imageSrc.substring(0, 20)}...`);
      }

      logger.withTag('imageProcessorService').debug(`Successfully loaded image from: ${extractUrlId(imageSrc)}...`);

      return imageBitmap;
    } catch (error) {
      logger.withTag('imageProcessorService').error('Failed to load image:', error);
      throw new Error(`Failed to load image from ${imageSrc.substring(0, 50)}...`, { cause: error });
    }
  }

  private async loadBlobImage(blobUrl: string): Promise<ImageBitmap> {
    logger.withTag('imageProcessorService').debug('Loading blob image');
    const response = await fetch(blobUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch blob: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  private async loadDataUrlImage(dataUrl: string): Promise<ImageBitmap> {
    logger.withTag('imageProcessorService').debug('Loading data URL image');
    const response = await fetch(dataUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch data URL: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  private async loadUrlImage(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  getImageDimensions(imageBitmap: ImageBitmap): {
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
  convertImageToCanvas(imageBitmap: ImageBitmap, imgsz: [number, number]): OffscreenCanvas {
    const canvas = new OffscreenCanvas(imgsz[0], imgsz[1]);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas context is not available');
    }

    const originalWidth = imageBitmap.width;
    const originalHeight = imageBitmap.height;

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
   * @param imageBitmap The image to convert
   * @param imgsz Target size [width, height] from YOLO metadata
   * @returns TensorFlow tensor ready for model inference
   */
  tensorFromImageBitmap(imageBitmap: ImageBitmap, imgsz: [number, number]): tf.Tensor4D {
    // Convert to canvas first
    const canvas = this.convertImageToCanvas(imageBitmap, imgsz);

    // Convert canvas to tensor - OffscreenCanvas is supported in newer TensorFlow.js versions
    const imageTensor = tf.browser
      .fromPixels(canvas as unknown as HTMLCanvasElement)
      .toFloat()
      .div(tf.scalar(255.0)); // Normalize to [0, 1]

    // Add batch dimension
    return imageTensor.expandDims(0);
  }

  /**
   * Calculate scale factors for converting model outputs back to original image coordinates
   * @param originalWidth Original image width
   * @param originalHeight Original image height
   * @param modelWidth Model input width
   * @param modelHeight Model input height
   * @returns Scale factors and offsets for coordinate conversion
   */
  calculateScaleFactors(
    originalWidth: number,
    originalHeight: number,
    modelWidth: number,
    modelHeight: number,
  ): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
    const scale = Math.min(modelWidth / originalWidth, modelHeight / originalHeight);

    const scaledWidth = originalWidth * scale;
    const scaledHeight = originalHeight * scale;

    const offsetX = (modelWidth - scaledWidth) / 2;
    const offsetY = (modelHeight - scaledHeight) / 2;

    return {
      scaleX: originalWidth / scaledWidth,
      scaleY: originalHeight / scaledHeight,
      offsetX,
      offsetY,
    };
  }
}
