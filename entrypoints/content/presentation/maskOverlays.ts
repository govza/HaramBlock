import { computeRenderedContentRect, maskGridSrcRect } from '@/entrypoints/content/presentation/imageLayout';
import { logger, extractUrlId } from '@/utils/logger';

import type { IImagePrediction, IMaskTransform } from '@/utils/types';

// Per-image overlay + observers state
interface ImageOverlayState {
  overlay: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  resizeObserver: ResizeObserver;
  cleanupObserver: MutationObserver;
  lastSize: { width: number; height: number };
  rafId?: number | null;
  destroyed?: boolean;
  currentPrediction?: IImagePrediction;
  viewportHandler?: () => void;
}

const imageStates = new WeakMap<HTMLImageElement, ImageOverlayState>();

export const createMaskOverlays = (
  image: HTMLImageElement,
  imagePrediction?: IImagePrediction,
  skipObserverSetup = false,
): void => {
  logger.withTag('maskOverlay').debug('createMaskOverlays called', {
    hasImagePrediction: imagePrediction,
    predictionsLength: imagePrediction?.predictions.length || 0,
    imageComplete: image.complete,
    imageNaturalWidth: image.naturalWidth,
    imageSrc: extractUrlId(image.src || image.currentSrc),
  });

  if (!imagePrediction || !imagePrediction.predictions.length || !image.complete || image.naturalWidth === 0) {
    logger.withTag('maskOverlay').debug('Early return from createMaskOverlays', {
      hasImagePrediction: imagePrediction,
      predictionsLength: imagePrediction?.predictions.length || 0,
      imageComplete: image.complete,
      imageNaturalWidth: image.naturalWidth,
    });
    return;
  }

  const parent = image.parentElement;
  if (!parent) return;

  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  // If we already manage an overlay for this image, just update/redraw
  const existingState = imageStates.get(image);
  if (existingState && !existingState.destroyed) {
    // Update stored prediction and re-render
    if (imagePrediction) existingState.currentPrediction = imagePrediction;
    updateOverlayForImage(image, existingState);
    return;
  }

  // Remove legacy overlays created by older runs (one-time cleanup)
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
    const state = createSingleMaskOverlay(
      image,
      allMasks,
      imagePrediction.maskTransform,
      imagePrediction.imageWidth,
      imagePrediction.imageHeight,
    );

    // Set up observers for this image (only on initial setup)
    if (!skipObserverSetup) {
      state.currentPrediction = imagePrediction;
      setupImageObservers(image, state);
    }
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
): ImageOverlayState => {
  const parent = image.parentElement;
  if (!parent) throw new Error('Image has no parent');

  // Force layout recalculation to get accurate dimensions
  void image.offsetHeight; // trigger reflow

  const imageRect = image.getBoundingClientRect();
  const contentRect = computeRenderedContentRect(image, imageRect);
  const parentRect = parent.getBoundingClientRect();

  logger.withTag('maskOverlay').debug('Creating single mask overlay', {
    imageRect: { width: imageRect.width, height: imageRect.height },
    imageSrc: extractUrlId(image.src || image.currentSrc),
  });

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

  // Create canvas once and reuse on updates
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: ${imageRect.width}px;
    height: ${imageRect.height}px;
    pointer-events: none;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  `;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    logger.withTag('maskOverlay').error('Failed to get canvas context');
    throw new Error('Failed to get canvas context');
  }

  overlay.appendChild(canvas);
  parent.appendChild(overlay);

  const state: ImageOverlayState = {
    overlay,
    canvas,
    ctx,
    // placeholders, real observers are attached in setupImageObservers
    resizeObserver: new ResizeObserver(() => {}),
    cleanupObserver: new MutationObserver(() => {}),
    lastSize: { width: imageRect.width, height: imageRect.height },
    rafId: null,
    destroyed: false,
    currentPrediction: undefined,
  };

  // Initial render
  renderUnifiedCanvasMask(
    canvas,
    ctx,
    allMasks,
    maskTransform,
    originalWidth,
    originalHeight,
    imageRect.width, // overlay (element) width
    imageRect.height, // overlay (element) height
    image,
    contentRect.offsetX,
    contentRect.offsetY,
    contentRect.width,
    contentRect.height,
  );

  // Store state for subsequent updates
  imageStates.set(image, state);
  return state;
};

const renderUnifiedCanvasMask = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  allMasks: { masks: number[][]; boundingBox: { x: number; y: number; width: number; height: number } }[],
  maskTransform: IMaskTransform,
  originalWidth: number,
  originalHeight: number,
  overlayWidth: number,
  overlayHeight: number,
  image: HTMLImageElement,
  offsetXInOverlay = 0,
  offsetYInOverlay = 0,
  contentWidth?: number,
  contentHeight?: number,
): void => {
  if (!allMasks || !allMasks.length) return;
  if (overlayWidth <= 0 || overlayHeight <= 0) return;

  const dWidth = contentWidth ?? overlayWidth;
  const dHeight = contentHeight ?? overlayHeight;

  // Ensure canvas bitmap matches display size for crisp pixels
  canvas.width = overlayWidth;
  canvas.height = overlayHeight;
  canvas.style.width = `${overlayWidth}px`;
  canvas.style.height = `${overlayHeight}px`;

  // 1) Create a pixelated copy of the image covering the display area
  // Calculate scale factors between natural and display dimensions
  const naturalToDisplayScaleX = dWidth / image.naturalWidth;
  const naturalToDisplayScaleY = dHeight / image.naturalHeight;
  const avgScale = (naturalToDisplayScaleX + naturalToDisplayScaleY) / 2;

  // Adjust block size based on the scaling to maintain consistent pixelation
  const BLOCK_SIZE = Math.max(8, Math.min(dWidth, dHeight) / 25 / avgScale);

  logger.withTag('maskOverlay').debug('Rendering unified canvas mask', {
    displaySize: { width: dWidth, height: dHeight },
    originalSize: { width: originalWidth, height: originalHeight },
    blockSize: BLOCK_SIZE,
    imageSrc: extractUrlId(image.src || image.currentSrc),
  });
  // Use natural dimensions scaled by block size for proper pixelation
  const smallW = Math.max(1, Math.floor(image.naturalWidth / BLOCK_SIZE));
  const smallH = Math.max(1, Math.floor(image.naturalHeight / BLOCK_SIZE));

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

  // Use the entire natural image dimensions for proper scaling
  tctx.drawImage(
    image,
    0,
    0,
    image.naturalWidth,
    image.naturalHeight, // source rect (entire natural image)
    0,
    0,
    smallW,
    smallH, // destination rect (small canvas)
  );

  ctx.imageSmoothingEnabled = false; // crisp, blocky upscale
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw pixelated image only in the actual rendered content box inside the <img>
  ctx.drawImage(tmp, offsetXInOverlay, offsetYInOverlay, dWidth, dHeight);

  // 2) Build alpha mask via grid-space canvas, then scale/crop to image content
  const first = allMasks.find(m => m.masks && m.masks.length);
  const gridH = first?.masks.length || 0;
  const gridW = first?.masks[0]?.length || 0;
  if (!gridW || !gridH) return;

  const maskGrid = document.createElement('canvas');
  maskGrid.width = gridW;
  maskGrid.height = gridH;
  const mg = maskGrid.getContext('2d');
  if (!mg) {
    logger.withTag('maskOverlay').error('Failed to get grid mask context');
    return;
  }
  mg.clearRect(0, 0, gridW, gridH);
  mg.fillStyle = 'rgba(0,0,0,1)';

  const { scaleX, scaleY, offsetX, offsetY } = maskTransform;
  const maskThreshold = 0.5;

  // Merge masks into grid by OR-ing cells that pass threshold and bbox
  for (const { masks, boundingBox } of allMasks) {
    const mh = masks.length;
    const mw = masks[0]?.length || 0;
    if (mw !== gridW || mh !== gridH) continue;

    for (let y = 0; y < mh; y++) {
      const row = masks[y];
      if (!row) continue;
      for (let x = 0; x < mw; x++) {
        const v = row[x];
        if (typeof v !== 'number' || v <= maskThreshold) continue;

        const imgX = (x - offsetX) * scaleX;
        const imgY = (y - offsetY) * scaleY;
        if (
          imgX >= boundingBox.x &&
          imgX <= boundingBox.x + boundingBox.width &&
          imgY >= boundingBox.y &&
          imgY <= boundingBox.y + boundingBox.height
        ) {
          mg.fillRect(x, y, 1, 1);
        }
      }
    }
  }

  // Prepare mask onto overlay-sized canvas then composite
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = overlayWidth;
  maskCanvas.height = overlayHeight;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) {
    logger.withTag('maskOverlay').error('Failed to get mask canvas context');
    return;
  }
  maskCtx.clearRect(0, 0, overlayWidth, overlayHeight);

  // Source sub-rect in grid that corresponds to actual image content (excludes letterbox)
  const { srcX, srcY, srcW, srcH } = maskGridSrcRect(maskTransform, originalWidth, originalHeight);

  // Draw scaled mask aligned to image content rect inside the overlay
  maskCtx.imageSmoothingEnabled = false;
  maskCtx.drawImage(maskGrid, srcX, srcY, srcW, srcH, offsetXInOverlay, offsetYInOverlay, dWidth, dHeight);

  // 3) Keep only the masked parts of the pixelated image
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
};

const setupImageObservers = (image: HTMLImageElement, state: ImageOverlayState): void => {
  // Disconnect previous observers if any (for safety on re-init)
  try {
    state.resizeObserver.disconnect();
  } catch {
    // Observer may not exist or already disconnected
  }
  try {
    state.cleanupObserver.disconnect();
  } catch {
    // Observer may not exist or already disconnected
  }
  if (state.viewportHandler) {
    globalThis.removeEventListener('resize', state.viewportHandler);
    globalThis.removeEventListener('scroll', state.viewportHandler);
    state.viewportHandler = undefined;
  }

  const parent = image.parentElement;
  if (!parent) return;

  const scheduleUpdate = () => {
    if (state.destroyed) return;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(() => {
      updateOverlayForImage(image, state);
      state.rafId = null;
    });
  };

  state.lastSize = { width: image.offsetWidth, height: image.offsetHeight };

  // ResizeObserver for image size changes
  state.resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const newWidth = entry.contentRect.width;
      const newHeight = entry.contentRect.height;
      if (newWidth !== state.lastSize.width || newHeight !== state.lastSize.height) {
        logger.withTag('maskOverlay').debug('ResizeObserver: Image size changed', {
          src: extractUrlId(image.src || image.currentSrc),
          oldSize: state.lastSize,
          newSize: { width: newWidth, height: newHeight },
        });
        state.lastSize = { width: newWidth, height: newHeight };
        scheduleUpdate();
      }
    }
  });
  state.resizeObserver.observe(image);

  // Viewport changes that can affect layout
  state.viewportHandler = () => scheduleUpdate();
  globalThis.addEventListener('resize', state.viewportHandler);
  globalThis.addEventListener('scroll', state.viewportHandler, { passive: true } as AddEventListenerOptions);

  // Clean up when image is removed
  state.cleanupObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const removedNode of mutation.removedNodes) {
        const removedEl = removedNode as Element;
        if (removedNode === image || (removedNode.nodeType === Node.ELEMENT_NODE && removedEl.contains(image))) {
          try {
            state.resizeObserver.disconnect();
          } catch {
            // Observer may not exist or already disconnected
          }
          try {
            state.cleanupObserver.disconnect();
          } catch {
            // Observer may not exist or already disconnected
          }
          if (state.viewportHandler) {
            globalThis.removeEventListener('resize', state.viewportHandler);
            globalThis.removeEventListener('scroll', state.viewportHandler);
            state.viewportHandler = undefined;
          }
          imageStates.delete(image);
          state.destroyed = true;
          if (state.overlay.parentElement) state.overlay.remove();
          break;
        }
      }
    }
  });
  state.cleanupObserver.observe(document.body, { childList: true, subtree: true });
};

function updateOverlayForImage(image: HTMLImageElement, state: ImageOverlayState): void {
  const imagePrediction = state.currentPrediction;
  if (!imagePrediction || !imagePrediction.predictions.length) return;
  const parent = image.parentElement;
  if (!parent || state.destroyed) return;

  // Force layout recalculation to get accurate dimensions
  void image.offsetHeight; // reflow

  const imageRect = image.getBoundingClientRect();
  const contentRect = computeRenderedContentRect(image, imageRect);
  const parentRect = parent.getBoundingClientRect();

  // Update overlay position and size
  state.overlay.style.top = `${imageRect.top - parentRect.top}px`;
  state.overlay.style.left = `${imageRect.left - parentRect.left}px`;
  state.overlay.style.width = `${imageRect.width}px`;
  state.overlay.style.height = `${imageRect.height}px`;

  // Collect masks
  const allMasks: { masks: number[][]; boundingBox: { x: number; y: number; width: number; height: number } }[] = [];
  imagePrediction.predictions.forEach(prediction => {
    if (prediction.masks && prediction.masks.length > 0) {
      allMasks.push({ masks: prediction.masks, boundingBox: prediction.boundingBox });
    }
  });
  if (!allMasks.length) return;

  renderUnifiedCanvasMask(
    state.canvas,
    state.ctx,
    allMasks,
    imagePrediction.maskTransform,
    imagePrediction.imageWidth,
    imagePrediction.imageHeight,
    imageRect.width,
    imageRect.height,
    image,
    contentRect.offsetX,
    contentRect.offsetY,
    contentRect.width,
    contentRect.height,
  );
}
