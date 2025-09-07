/**
 * Calculate scale factors for converting model outputs back to original image coordinates
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
