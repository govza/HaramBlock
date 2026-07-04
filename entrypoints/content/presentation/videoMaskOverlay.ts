import { computeRenderedContentRect, maskGridSrcRect } from '@/entrypoints/content/presentation/imageLayout';
import { overlayLayer } from '@/entrypoints/content/presentation/layer/overlayLayer';
import { ensureCorsSafeSource } from '@/entrypoints/content/video/frameCapture';
import { logger } from '@/utils/logger';
import { calculatePixelationBlockSize, buildCanvasTintFilter } from '@/utils/masking';
import { decodeMaskRLE } from '@/utils/rle';

import type { IHostSettings, IImagePrediction, IMaskTransform, IMaskingSettings } from '@/utils/types';
import type { ILayerGeometry, IMediaOverlayState, IMediaOverlay } from '@/utils/types/presentation';

/** Decode all RLE masks of a prediction once; geometry updates reuse the grids. */
function decodePredictionMasks(prediction: IImagePrediction): { masks: number[][] }[] {
  const allMasks: { masks: number[][] }[] = [];
  prediction.predictions.forEach(elementPrediction => {
    if (elementPrediction.masks && elementPrediction.masks.runs.length > 0) {
      allMasks.push({ masks: decodeMaskRLE(elementPrediction.masks) });
    }
  });
  return allMasks;
}

const CANVAS_STYLE = [
  'position: absolute',
  'top: 0',
  'left: 0',
  'pointer-events: none',
  'image-rendering: pixelated',
  'image-rendering: crisp-edges',
].join('; ');

/**
 * Manages mask overlays for video elements, rendered into the extension-owned overlay
 * layer (never into site DOM).
 * Implements IMediaOverlay<HTMLVideoElement>
 */
class VideoMaskOverlay implements IMediaOverlay<HTMLVideoElement> {
  private videoStates = new WeakMap<HTMLVideoElement, IMediaOverlayState>();

  /**
   * Creates mask overlay for video elements using poster images or first frame.
   */
  async createMaskOverlay(
    video: HTMLVideoElement,
    imagePrediction: IImagePrediction,
    hostSettings: IHostSettings,
  ): Promise<void> {
    if (!imagePrediction.predictions.length) {
      this.clearMaskOverlay(video);
      return;
    }

    // Check for existing overlay
    const existingState = this.videoStates.get(video);
    if (existingState && !existingState.destroyed) {
      existingState.currentPrediction = imagePrediction;
      this.render(video, existingState);
      return;
    }

    // Remove overlays that pre-layer versions injected into site DOM
    removeExistingVideoOverlays(video.parentElement);

    const decodedMasks = decodePredictionMasks(imagePrediction);
    if (decodedMasks.length === 0) return;

    const isThumbnail = imagePrediction.cacheMetadata?.contentType === 'video/thumbnail';

    let posterImage: HTMLImageElement | undefined;
    if (isThumbnail && video.poster) {
      try {
        posterImage = await loadPosterImage(video.poster);
      } catch {
        // no-op
      }
    }

    // Get CORS-safe video source for cross-origin videos
    let corsVideo: HTMLVideoElement | undefined;
    if (!posterImage) {
      try {
        corsVideo = await ensureCorsSafeSource(video);
      } catch {
        corsVideo = video;
      }
    }

    // A concurrent call may have set up the overlay while we awaited
    const concurrentState = this.videoStates.get(video);
    if (concurrentState && !concurrentState.destroyed) {
      concurrentState.currentPrediction = imagePrediction;
      this.render(video, concurrentState);
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.style.cssText = CANVAS_STYLE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      logger.withTag('videoOverlay').error('Failed to get canvas context');
      return;
    }

    const state: IMediaOverlayState = {
      canvas,
      ctx,
      lastSize: { width: 0, height: 0 },
      destroyed: false,
      currentPrediction: imagePrediction,
      posterImage,
      corsVideo,
      masking: hostSettings.masking,
      decodedMasks,
      decodedFor: imagePrediction,
      // assigned below; attach() fires the initial geometry callback synchronously
      // and the callback does not touch state.slot
      slot: undefined as unknown as IMediaOverlayState['slot'],
    };
    this.videoStates.set(video, state);

    state.slot = overlayLayer.attach(
      video,
      {
        onGeometry: geometry => this.handleGeometry(video, state, geometry),
        onDetach: () => this.teardown(video, state, { releaseSlot: false }),
      },
      'video-mask',
    );
    state.slot.root.appendChild(canvas);
  }

  /**
   * Clears mask overlay for video elements.
   */
  clearMaskOverlay(video: HTMLVideoElement): void {
    const state = this.videoStates.get(video);
    if (state) {
      this.teardown(video, state, { releaseSlot: true });
    } else {
      // Remove stale pre-layer overlay elements
      removeExistingVideoOverlays(video.parentElement);
    }
  }

  /**
   * Checks if video has an active mask overlay.
   */
  hasMaskOverlay(video: HTMLVideoElement): boolean {
    return this.videoStates.has(video);
  }

  private teardown(video: HTMLVideoElement, state: IMediaOverlayState, opts: { releaseSlot: boolean }): void {
    state.destroyed = true;
    if (opts.releaseSlot) state.slot?.release();
    this.videoStates.delete(video);
  }

  private handleGeometry(video: HTMLVideoElement, state: IMediaOverlayState, { rect }: ILayerGeometry): void {
    if (state.destroyed) return;
    // The layer already moved the slot; only a size change requires a redraw.
    if (rect.width === state.lastSize.width && rect.height === state.lastSize.height) return;
    state.lastSize = { width: rect.width, height: rect.height };
    this.render(video, state);
  }

  private render(video: HTMLVideoElement, state: IMediaOverlayState): void {
    if (state.destroyed) return;
    const prediction = state.currentPrediction;
    if (!prediction || !prediction.predictions?.length) return;
    const { width, height } = state.lastSize;
    if (width <= 0 || height <= 0) return;

    // Refresh the decoded-mask cache if the prediction was replaced
    if (state.decodedFor !== prediction) {
      state.decodedMasks = decodePredictionMasks(prediction);
      state.decodedFor = prediction;
    }
    if (!state.decodedMasks?.length) return;

    const { posterImage } = state;
    const contentRect = computeRenderedContentRectWithDimensions(
      video,
      state.lastSize,
      posterImage ? posterImage.naturalWidth : undefined,
      posterImage ? posterImage.naturalHeight : undefined,
    );

    renderVideoMask(
      state.canvas,
      state.ctx,
      state.decodedMasks,
      prediction.maskTransform,
      prediction.width,
      prediction.height,
      width,
      height,
      state.corsVideo || video,
      contentRect.offsetX,
      contentRect.offsetY,
      contentRect.width,
      contentRect.height,
      posterImage,
      state.masking,
    );
  }
}

/**
 * Renders the mask specifically for videos using poster image or video frame.
 * Follows the same pattern as imageMaskOverlay.ts:
 * - Uses element dimensions (poster/video natural dimensions) for texture generation
 * - Uses originalWidth/Height (inference dimensions) for mask coordinate transformation
 */
function renderVideoMask(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  allMasks: { masks: number[][] }[],
  maskTransform: IMaskTransform,
  originalWidth: number, // Inference dimensions (from model) - used for mask coordinate transform
  originalHeight: number,
  overlayWidth: number,
  overlayHeight: number,
  video: HTMLVideoElement,
  offsetXInOverlay: number,
  offsetYInOverlay: number,
  contentWidth: number,
  contentHeight: number,
  posterImage: HTMLImageElement | undefined,
  masking: IMaskingSettings,
): void {
  if (!allMasks || !allMasks.length) {
    logger.withTag('videoOverlay').warn('renderVideoMask: No masks provided');
    return;
  }
  if (overlayWidth <= 0 || overlayHeight <= 0) {
    logger.withTag('videoOverlay').warn('renderVideoMask: Invalid overlay dimensions');
    return;
  }
  if (contentWidth <= 0 || contentHeight <= 0) {
    logger.withTag('videoOverlay').warn('renderVideoMask: Invalid content dimensions');
    return;
  }

  const dWidth = contentWidth;
  const dHeight = contentHeight;

  canvas.width = overlayWidth;
  canvas.height = overlayHeight;
  canvas.style.width = `${overlayWidth}px`;
  canvas.style.height = `${overlayHeight}px`;

  // Use poster image if available, otherwise fall back to video
  const sourceElement = posterImage || video;

  // Get actual element dimensions (following the same pattern as imageMaskOverlay.ts)
  const elementWidth = posterImage ? posterImage.naturalWidth : video.videoWidth || video.clientWidth;
  const elementHeight = posterImage ? posterImage.naturalHeight : video.videoHeight || video.clientHeight;

  if (!elementWidth || !elementHeight) {
    logger.withTag('videoOverlay').warn('No element dimensions available', {
      posterImage: Boolean(posterImage),
      videoWidth: video.videoWidth,
      clientWidth: video.clientWidth,
    });
    return;
  }

  const blockSize = calculatePixelationBlockSize(masking.pixelationScale);
  const smallW = Math.max(1, Math.floor(dWidth / blockSize));
  const smallH = Math.max(1, Math.floor(dHeight / blockSize));

  logger.withTag('videoOverlay').debug('Rendering video mask', {
    displaySize: { width: dWidth, height: dHeight },
    elementSize: { width: elementWidth, height: elementHeight },
    inferenceSize: { width: originalWidth, height: originalHeight },
    blockSize,
    usingPoster: Boolean(posterImage),
    videoSrc: video.src || video.currentSrc,
  });

  const tmp = document.createElement('canvas');
  tmp.width = smallW;
  tmp.height = smallH;
  const tctx = tmp.getContext('2d');
  if (!tctx) return;

  // Downscale to small with smoothing, then upscale without smoothing to get blocky squares
  tctx.imageSmoothingEnabled = true;
  tctx.clearRect(0, 0, smallW, smallH);

  try {
    // Use the entire natural element dimensions for proper scaling
    tctx.drawImage(sourceElement, 0, 0, elementWidth, elementHeight, 0, 0, smallW, smallH);
  } catch (error) {
    logger.withTag('videoOverlay').error('Failed to draw source element:', error);
    return;
  }

  // Draw to main canvas
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, offsetXInOverlay, offsetYInOverlay, dWidth, dHeight);

  // Apply mask
  applyVideoMask(
    ctx,
    allMasks,
    maskTransform,
    originalWidth,
    originalHeight,
    overlayWidth,
    overlayHeight,
    offsetXInOverlay,
    offsetYInOverlay,
    dWidth,
    dHeight,
  );

  // Apply tint effects via CSS filter (hardware-accelerated)
  canvas.style.filter = buildCanvasTintFilter(masking);
}

/**
 * Applies the segmentation mask to the video overlay
 */
function applyVideoMask(
  ctx: CanvasRenderingContext2D,
  allMasks: { masks: number[][] }[],
  maskTransform: IMaskTransform,
  originalWidth: number,
  originalHeight: number,
  overlayWidth: number,
  overlayHeight: number,
  offsetXInOverlay: number,
  offsetYInOverlay: number,
  dWidth: number,
  dHeight: number,
): void {
  const first = allMasks.find(m => m.masks && m.masks.length);
  const gridH = first?.masks.length || 0;
  const gridW = first?.masks[0]?.length || 0;
  if (!gridW || !gridH) return;

  const maskGrid = document.createElement('canvas');
  maskGrid.width = gridW;
  maskGrid.height = gridH;
  const mg = maskGrid.getContext('2d');
  if (!mg) return;

  mg.clearRect(0, 0, gridW, gridH);
  mg.fillStyle = 'rgba(0,0,0,1)';

  const maskThreshold = 0.5;

  // Build mask grid using ImageData for speed
  for (const { masks } of allMasks) {
    const mh = masks.length;
    const mw = masks[0]?.length || 0;
    if (mw !== gridW || mh !== gridH) continue;

    const imageData = mg.createImageData(gridW, gridH);
    const { data } = imageData; // RGBA
    let idx = 0;
    for (let y = 0; y < mh; y++) {
      const row = masks[y];
      if (!row) {
        idx += gridW * 4;
        continue;
      }
      for (let x = 0; x < mw; x++) {
        const v = row[x];
        const a = typeof v === 'number' && v > maskThreshold ? 255 : 0;
        data[idx] = 0; // R
        data[idx + 1] = 0; // G
        data[idx + 2] = 0; // B
        data[idx + 3] = a; // A
        idx += 4;
      }
    }
    mg.putImageData(imageData, 0, 0);
  }

  // Apply mask to overlay
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = overlayWidth;
  maskCanvas.height = overlayHeight;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return;

  maskCtx.clearRect(0, 0, overlayWidth, overlayHeight);

  const { srcX, srcY, srcW, srcH } = maskGridSrcRect(maskTransform, originalWidth, originalHeight);

  maskCtx.imageSmoothingEnabled = false;
  maskCtx.drawImage(maskGrid, srcX, srcY, srcW, srcH, offsetXInOverlay, offsetYInOverlay, dWidth, dHeight);

  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
}

async function loadPosterImage(posterUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load poster image'));
    img.src = posterUrl;
  });
}

// Removes overlays that pre-layer versions of this module injected into site DOM
// (extension updated while the page was open).
function removeExistingVideoOverlays(parent: HTMLElement | null): void {
  if (!parent) return;
  const existingOverlays = parent.querySelectorAll('[data-video-mask-overlay]');
  existingOverlays.forEach(overlay => overlay.remove());
}

/**
 * Compute rendered content rect with override dimensions.
 * This is needed when the source dimensions (e.g., poster) differ from video natural dimensions.
 */
function computeRenderedContentRectWithDimensions(
  video: HTMLVideoElement,
  videoRect: { width: number; height: number },
  sourceWidth?: number,
  sourceHeight?: number,
): { offsetX: number; offsetY: number; width: number; height: number } {
  if (!sourceWidth || !sourceHeight) {
    return computeRenderedContentRect(video, videoRect);
  }

  const boxW = videoRect.width;
  const boxH = videoRect.height;

  if (!boxW || !boxH) {
    return { offsetX: 0, offsetY: 0, width: boxW, height: boxH };
  }

  const style = getComputedStyle(video);
  const fit = (style.objectFit || 'fill').toLowerCase();
  const pos = (style.objectPosition || '50% 50%').trim().split(' ');

  const parsePos = (v: string, total: number, content: number): number => {
    if (!v) return (total - content) / 2;
    if (v.endsWith('%')) {
      const pct = Number(v.slice(0, -1));
      if (Number.isFinite(pct)) return ((total - content) * pct) / 100;
    }
    if (v.endsWith('px')) {
      const px = Number(v.slice(0, -2));
      if (Number.isFinite(px)) return px;
    }
    const map: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
    if (v in map && map[v] !== undefined) return (total - content) * map[v];
    return (total - content) / 2;
  };

  if (fit === 'fill') {
    return { offsetX: 0, offsetY: 0, width: boxW, height: boxH };
  }

  if (fit === 'none') {
    const offX = parsePos(pos[0] || '50%', boxW, sourceWidth);
    const offY = parsePos(pos[1] || '50%', boxH, sourceHeight);
    return { offsetX: offX, offsetY: offY, width: sourceWidth, height: sourceHeight };
  }

  if (fit === 'contain' || fit === 'scale-down') {
    const scale = Math.min(boxW / sourceWidth, boxH / sourceHeight);
    const finalScale = fit === 'scale-down' ? Math.min(1, scale) : scale;
    const contentW = sourceWidth * finalScale;
    const contentH = sourceHeight * finalScale;
    const offX = parsePos(pos[0] || '50%', boxW, contentW);
    const offY = parsePos(pos[1] || '50%', boxH, contentH);
    return { offsetX: offX, offsetY: offY, width: contentW, height: contentH };
  }

  if (fit === 'cover') {
    const scale = Math.max(boxW / sourceWidth, boxH / sourceHeight);
    const contentW = sourceWidth * scale;
    const contentH = sourceHeight * scale;
    const offX = parsePos(pos[0] || '50%', boxW, contentW);
    const offY = parsePos(pos[1] || '50%', boxH, contentH);
    return { offsetX: offX, offsetY: offY, width: contentW, height: contentH };
  }

  return { offsetX: 0, offsetY: 0, width: boxW, height: boxH };
}

// Export singleton instance
export const videoMaskOverlays = new VideoMaskOverlay();
