import type { IElementPrediction, IMaskTransform } from '@/utils/types';

/**
 * Masks are cropped to the image content before RLE encoding, so the grid carries no letterbox
 * padding: the transform is a pure scale from the mask grid to the original image size.
 */
export const croppedMaskTransform = (
  predictions: readonly IElementPrediction[],
  imageWidth: number,
  imageHeight: number,
): IMaskTransform => {
  const firstMask = predictions.find(prediction => prediction.masks && prediction.masks.runs.length > 0)?.masks;
  return {
    scaleX: imageWidth / (firstMask?.width ?? 1),
    scaleY: imageHeight / (firstMask?.height ?? 1),
    offsetX: 0,
    offsetY: 0,
  };
};
