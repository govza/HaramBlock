import { type CoordinateTransform, type ModelDetection } from '@/entrypoints/background/modelUtils/types';

/**
 * Calculate bounding box coordinates from YOLO detection data
 * @param detection - YOLO detection data from model
 * @param transform - Coordinate transformation parameters
 * @returns Bounding box in image coordinates
 */
export function getBoundingBox(detection: ModelDetection, transform: CoordinateTransform) {
  const { x1, y1, x2, y2 } = detection;
  const { scaleX, scaleY, offsetX, offsetY } = transform;

  // Convert model coordinates back to original image coordinates
  const modelX1 = x1 - offsetX;
  const modelY1 = y1 - offsetY;
  const modelX2 = x2 - offsetX;
  const modelY2 = y2 - offsetY;

  const upSampleBox: [number, number, number, number] = [
    Math.floor(modelY1 * scaleY),
    Math.floor(modelX1 * scaleX),
    Math.round((modelY2 - modelY1) * scaleY),
    Math.round((modelX2 - modelX1) * scaleX),
  ];

  return {
    x: upSampleBox[1],
    y: upSampleBox[0],
    width: upSampleBox[3],
    height: upSampleBox[2],
  };
}
