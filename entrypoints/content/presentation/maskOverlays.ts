import { logger } from '@/utils/logger';
import { type IImagePrediction, type IMaskTransform } from '@/utils/types';

export const createMaskOverlays = (image: HTMLImageElement, imagePrediction?: IImagePrediction): void => {
  if (!imagePrediction || !imagePrediction.predictions.length || !image.complete || image.naturalWidth === 0) return;

  const parent = image.parentElement;
  if (!parent) return;

  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  // Remove existing overlays first
  removeExistingOverlays(parent);

  // Collect all masks and bounding boxes for single overlay
  const allMasks: { masks: number[][]; boundingBox: { x: number; y: number; width: number; height: number } }[] = [];
  imagePrediction.predictions.forEach(prediction => {
    if (prediction.masks && prediction.masks.length > 0) {
      allMasks.push({
        masks: prediction.masks,
        boundingBox: prediction.boundingBox,
      });
    }
  });

  // Create single overlay for all masks
  if (allMasks.length > 0) {
    createSingleMaskOverlay(
      image,
      allMasks,
      imagePrediction.maskTransform,
      imagePrediction.imageWidth,
      imagePrediction.imageHeight,
    );
  }
};

const removeExistingOverlays = (parent: HTMLElement): void => {
  const existingOverlays = parent.querySelectorAll('[data-mask-overlay]');
  existingOverlays.forEach(overlay => overlay.remove());
};

const createSingleMaskOverlay = (
  image: HTMLImageElement,
  allMasks: { masks: number[][]; boundingBox: { x: number; y: number; width: number; height: number } }[],
  maskTransform: IMaskTransform,
  originalWidth: number,
  originalHeight: number,
): void => {
  const parent = image.parentElement;
  if (!parent) return;

  const imageRect = image.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();

  // Create single overlay container for all masks
  const overlay = document.createElement('div');
  overlay.setAttribute('data-mask-overlay', 'unified-mask-overlay');

  // Get the image's z-index and add 1
  const imageZIndex = parseInt(getComputedStyle(image).zIndex) || 0;
  const overlayZIndex = imageZIndex + 1;

  overlay.style.cssText = `
    position: absolute;
    top: ${imageRect.top - parentRect.top}px;
    left: ${imageRect.left - parentRect.left}px;
    width: ${imageRect.width}px;
    height: ${imageRect.height}px;
    pointer-events: none;
    z-index: ${overlayZIndex};
  `;

  // Create single canvas with all masks
  createUnifiedCanvasMask(
    overlay,
    allMasks,
    maskTransform,
    originalWidth,
    originalHeight,
    imageRect.width,
    imageRect.height,
    image,
  );

  parent.appendChild(overlay);
};

const createUnifiedCanvasMask = (
  overlay: HTMLElement,
  allMasks: { masks: number[][]; boundingBox: { x: number; y: number; width: number; height: number } }[],
  maskTransform: IMaskTransform,
  originalWidth: number,
  originalHeight: number,
  displayWidth: number,
  displayHeight: number,
  image: HTMLImageElement,
): void => {
  if (!allMasks || !allMasks.length) return;

  if (!maskTransform) {
    logger.withTag('maskOverlay').error('maskTransform not provided');
    return;
  }

  if (displayWidth <= 0 || displayHeight <= 0) {
    return;
  }

  // Main canvas sized to the displayed image area
  const canvas = document.createElement('canvas');
  canvas.width = displayWidth;
  canvas.height = displayHeight;
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: ${displayWidth}px;
    height: ${displayHeight}px;
    pointer-events: none;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  `;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    logger.withTag('maskOverlay').error('Failed to get canvas context');
    return;
  }

  // 1) Create a pixelated copy of the image (50x50px blocks) covering the display area
  const BLOCK_SIZE = 20; // display pixels per block (crisper, larger squares)
  const smallW = Math.max(1, Math.floor(displayWidth / BLOCK_SIZE));
  const smallH = Math.max(1, Math.floor(displayHeight / BLOCK_SIZE));

  const tmp = document.createElement('canvas');
  tmp.width = smallW;
  tmp.height = smallH;
  const tctx = tmp.getContext('2d');
  if (!tctx) {
    logger.withTag('maskOverlay').error('Failed to get tmp canvas context');
    return;
  }

  // Downscale to small with smoothing, then upscale without smoothing to get blocky squares
  tctx.imageSmoothingEnabled = true; // smoother downscale average
  tctx.clearRect(0, 0, smallW, smallH);
  tctx.drawImage(image, 0, 0, smallW, smallH);

  ctx.imageSmoothingEnabled = false; // crisp, blocky upscale
  ctx.clearRect(0, 0, displayWidth, displayHeight);
  ctx.drawImage(tmp, 0, 0, displayWidth, displayHeight);

  // 2) Build alpha mask on a separate canvas
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = displayWidth;
  maskCanvas.height = displayHeight;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) {
    logger.withTag('maskOverlay').error('Failed to get mask canvas context');
    return;
  }
  maskCtx.clearRect(0, 0, displayWidth, displayHeight);
  maskCtx.fillStyle = 'rgba(0,0,0,1)';

  allMasks.forEach(({ masks, boundingBox }) => {
    if (!masks || !masks.length) return;
    drawMaskToAlphaMask(
      maskCtx,
      masks,
      boundingBox,
      maskTransform,
      originalWidth,
      originalHeight,
      displayWidth,
      displayHeight,
    );
  });

  // 3) Keep only the masked parts of the pixelated image
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  overlay.appendChild(canvas);
};

/**
 * Paints the mask as an alpha shape into the provided context.
 * No color/tint is drawn—only opaque alpha where masked.
 */
function drawMaskToAlphaMask(
  ctx: CanvasRenderingContext2D,
  masks: number[][],
  boundingBox: { x: number; y: number; width: number; height: number },
  maskTransform: IMaskTransform,
  originalWidth: number,
  originalHeight: number,
  displayWidth: number,
  displayHeight: number,
): void {
  const maskHeight = masks.length;
  const maskWidth = masks[0]?.length || 0;

  const { imageScaleInModel, modelOffsetX, modelOffsetY } = maskTransform;
  const maskToImageScale = 1 / imageScaleInModel;

  // Scale factors from natural image to display
  const displayScaleX = displayWidth / originalWidth;
  const displayScaleY = displayHeight / originalHeight;

  // Adaptive sampling based on display resolution
  const minDisplayDimension = Math.min(displayWidth, displayHeight);
  const sampleStep = Math.max(
    1,
    minDisplayDimension > 0 ? Math.floor((Math.min(maskWidth, maskHeight) / minDisplayDimension) * 2) : 1,
  );

  // Ensure a minimum draw size for contiguous coverage
  const pixelSize = Math.max(1, Math.ceil(Math.min(displayScaleX, displayScaleY) * maskToImageScale * sampleStep));

  for (let maskY = 0; maskY < maskHeight; maskY += sampleStep) {
    const row = masks[maskY];
    if (!row) continue;
    for (let maskX = 0; maskX < maskWidth; maskX += sampleStep) {
      const v = row[maskX];
      if (typeof v !== 'number' || v <= 0.5) continue;

      // Convert mask coords -> natural image coords
      const imageX = (maskX - modelOffsetX) * maskToImageScale;
      const imageY = (maskY - modelOffsetY) * maskToImageScale;

      // Bounds + boundingBox check
      if (
        imageX >= 0 &&
        imageX < originalWidth &&
        imageY >= 0 &&
        imageY < originalHeight &&
        imageX >= boundingBox.x &&
        imageX <= boundingBox.x + boundingBox.width &&
        imageY >= boundingBox.y &&
        imageY <= boundingBox.y + boundingBox.height
      ) {
        // Natural image coords -> display coords
        const displayX = imageX * displayScaleX;
        const displayY = imageY * displayScaleY;

        ctx.fillRect(Math.floor(displayX), Math.floor(displayY), pixelSize, pixelSize);
      }
    }
  }
}
