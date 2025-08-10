import { type IElementPrediction } from '@/utils/types';

export interface EdgeCorrectionOptions {
  edgeThreshold?: number; // Percentage of image size to consider as edge (default: 0.02 = 2%)
}

/**
 * Adjusts bounding box and polygon points in predictions so that if any point is within the threshold of the image edge, it snaps to the edge.
 */
export function edgeBoundingBoxCorrection(
  predictions: IElementPrediction[],
  imageWidth: number,
  imageHeight: number,
  options: EdgeCorrectionOptions = {},
): IElementPrediction[] {
  const { edgeThreshold = 0.1 } = options;

  const edgeThresholdX = imageWidth * edgeThreshold;
  const edgeThresholdY = imageHeight * edgeThreshold;

  return predictions.map(prediction => {
    const { boundingBox, polygon } = prediction;

    // Correct bounding box
    const originalRight = boundingBox.x + boundingBox.width;
    const originalBottom = boundingBox.y + boundingBox.height;

    const correctedX = boundingBox.x <= edgeThresholdX ? 0 : boundingBox.x;
    const correctedY = boundingBox.y <= edgeThresholdY ? 0 : boundingBox.y;

    const correctedRight = originalRight >= imageWidth - edgeThresholdX ? imageWidth : originalRight;
    const correctedBottom = originalBottom >= imageHeight - edgeThresholdY ? imageHeight : originalBottom;

    const correctedBoundingBox = {
      x: correctedX,
      y: correctedY,
      width: correctedRight - correctedX,
      height: correctedBottom - correctedY,
    };

    return {
      ...prediction,
      boundingBox: correctedBoundingBox,
      polygon,
    };
  });
}
