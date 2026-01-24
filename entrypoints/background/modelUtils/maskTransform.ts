/**
 * Calculate scale factors for converting model outputs back to original image coordinates.
 * Uses the same rounding as preprocessing to ensure consistency.
 * @param originalWidth Original image width
 * @param originalHeight Original image height
 * @param modelWidth Model input width
 * @param modelHeight Model input height
 * @returns Scale factors and offsets for coordinate conversion
 */
export function calculateScaleFactors(
  originalWidth: number,
  originalHeight: number,
  modelWidth: number,
  modelHeight: number,
): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
  const scale = Math.min(modelWidth / originalWidth, modelHeight / originalHeight);

  // Match preprocessing: round the scaled dimensions
  const scaledWidth = Math.round(originalWidth * scale);
  const scaledHeight = Math.round(originalHeight * scale);

  // Keep offset as float (matches Python YOLO reference)
  const offsetX = (modelWidth - scaledWidth) / 2;
  const offsetY = (modelHeight - scaledHeight) / 2;

  return {
    scaleX: originalWidth / scaledWidth,
    scaleY: originalHeight / scaledHeight,
    offsetX,
    offsetY,
  };
}

/**
 * Calculate letterbox parameters for a given image and model input size.
 * Returns both input-space and prototype-space offsets.
 * Uses the same rounding as Python YOLO reference for consistency.
 */
export function calculateLetterboxParams(
  originalWidth: number,
  originalHeight: number,
  modelWidth: number,
  modelHeight: number,
  protoWidth: number,
  protoHeight: number,
): {
  scale: number;
  offsetX: number;
  offsetY: number;
  protoOffsetX: number;
  protoOffsetY: number;
  contentProtoWidth: number;
  contentProtoHeight: number;
} {
  const scale = Math.min(modelWidth / originalWidth, modelHeight / originalHeight);

  const scaledWidth = Math.round(originalWidth * scale);
  const scaledHeight = Math.round(originalHeight * scale);

  // Letterbox offset in input space
  const offsetX = (modelWidth - scaledWidth) / 2;
  const offsetY = (modelHeight - scaledHeight) / 2;

  // Convert to prototype space (stride = modelWidth / protoWidth)
  const strideX = modelWidth / protoWidth;
  const strideY = modelHeight / protoHeight;

  const protoOffsetX = offsetX / strideX;
  const protoOffsetY = offsetY / strideY;

  // Calculate crop boundaries using same rounding as processSegmentation (matches Python reference)
  const cropLeft = Math.round(protoOffsetX - 0.1);
  const cropTop = Math.round(protoOffsetY - 0.1);
  const cropRight = Math.round(protoWidth - protoOffsetX + 0.1);
  const cropBottom = Math.round(protoHeight - protoOffsetY + 0.1);

  // Content area = actual cropped mask dimensions
  const contentProtoWidth = cropRight - cropLeft;
  const contentProtoHeight = cropBottom - cropTop;

  return {
    scale,
    offsetX,
    offsetY,
    protoOffsetX,
    protoOffsetY,
    contentProtoWidth,
    contentProtoHeight,
  };
}
