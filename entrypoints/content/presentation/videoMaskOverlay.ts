import { computeRenderedContentRect, maskGridSrcRect } from '@/entrypoints/content/presentation/imageLayout';
import {
  classifyOverlayMutation,
  ensurePositionContext,
  overlayOffsetInParent,
} from '@/entrypoints/content/presentation/overlayPosition';
import { ensureCorsSafeSource } from '@/entrypoints/content/video/frameCapture';
import { logger } from '@/utils/logger';
import { calculatePixelationBlockSize, buildCanvasTintFilter } from '@/utils/masking';
import { decodeMaskRLE } from '@/utils/rle';

import type { IHostSettings, IImagePrediction, IMaskTransform, IMaskingSettings } from '@/utils/types';
import type { IMediaOverlayState, IMediaOverlay } from '@/utils/types/presentation';

/**
 * Manages mask overlays for video elements.
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
    skipObserverSetup = false,
  ): Promise<void> {
    if (!imagePrediction.predictions.length) {
      this.clearMaskOverlay(video);
      return;
    }

    const parent = video.parentElement;
    if (!parent) return;

    ensurePositionContext(parent);

    // Check for existing overlay
    const existingState = this.videoStates.get(video);
    if (existingState && !existingState.destroyed) {
      existingState.currentPrediction = imagePrediction;
      this.updateVideoOverlay(video, existingState);
      return;
    }

    // Remove any existing overlays
    removeExistingVideoOverlays(parent);

    const isThumbnail = imagePrediction.cacheMetadata?.contentType === 'video/thumbnail';

    let posterImage: HTMLImageElement | undefined;
    if (isThumbnail && video.poster) {
      try {
        posterImage = await loadPosterImage(video.poster);
      } catch {
        // no-op
      }
    }

    // Collect masks
    const allMasks: { masks: number[][] }[] = [];
    imagePrediction.predictions.forEach(prediction => {
      if (prediction.masks && prediction.masks.runs.length > 0) {
        allMasks.push({ masks: decodeMaskRLE(prediction.masks) });
      }
    });

    if (allMasks.length > 0) {
      const elementWidth = posterImage ? posterImage.naturalWidth : video.videoWidth || video.clientWidth;
      const elementHeight = posterImage ? posterImage.naturalHeight : video.videoHeight || video.clientHeight;

      const state = await this.createVideoOverlayElement(
        video,
        allMasks,
        imagePrediction.maskTransform,
        imagePrediction.width,
        imagePrediction.height,
        hostSettings.masking,
        posterImage,
        posterImage ? elementWidth : undefined,
        posterImage ? elementHeight : undefined,
      );

      if (!skipObserverSetup) {
        state.currentPrediction = imagePrediction;
        state.posterImage = posterImage;
        this.setupObservers(video, state);
      }
    }
  }

  /**
   * Clears mask overlay for video elements.
   */
  clearMaskOverlay(video: HTMLVideoElement): void {
    const state = this.videoStates.get(video);
    if (state) {
      try {
        state.resizeObserver.disconnect();
        state.cleanupObserver.disconnect();
      } catch {
        // no-op
      }
      if (state.viewportHandler) {
        globalThis.removeEventListener('resize', state.viewportHandler);
      }
      state.destroyed = true;
      liveVideoOverlays.delete(state.overlay);
      if (state.overlay.parentElement) state.overlay.remove();
      this.videoStates.delete(video);
    } else {
      // Fallback: remove any stale overlay elements
      const parent = video.parentElement;
      if (parent) {
        removeExistingVideoOverlays(parent);
      }
    }
  }

  /**
   * Checks if video has an active mask overlay.
   */
  hasMaskOverlay(video: HTMLVideoElement): boolean {
    return this.videoStates.has(video);
  }

  private async createVideoOverlayElement(
    video: HTMLVideoElement,
    allMasks: { masks: number[][] }[],
    maskTransform: IMaskTransform,
    originalWidth: number,
    originalHeight: number,
    masking: IMaskingSettings,
    posterImage?: HTMLImageElement,
    sourceWidth?: number,
    sourceHeight?: number,
  ): Promise<IMediaOverlayState> {
    const parent = video.parentElement;
    if (!parent) throw new Error('Video has no parent');

    void video.offsetHeight;

    const videoRect = video.getBoundingClientRect();
    const contentRect = computeRenderedContentRectWithDimensions(video, videoRect, sourceWidth, sourceHeight);
    const parentRect = parent.getBoundingClientRect();
    const offset = overlayOffsetInParent(parent, videoRect, parentRect);

    const overlay = document.createElement('div');
    overlay.setAttribute('data-video-mask-overlay', 'unified-video-mask-overlay');

    const videoZIndex = parseInt(getComputedStyle(video).zIndex) || 0;
    const overlayZIndex = Math.max(videoZIndex + 1, 9999);

    overlay.style.cssText = `
    position: absolute;
    top: ${offset.top}px;
    left: ${offset.left}px;
    width: ${videoRect.width}px;
    height: ${videoRect.height}px;
    overflow: hidden;
    pointer-events: none;
    z-index: ${overlayZIndex};
  `;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: ${videoRect.width}px;
    height: ${videoRect.height}px;
    pointer-events: none;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  `;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    overlay.appendChild(canvas);
    liveVideoOverlays.add(overlay);
    parent.appendChild(overlay);

    // Get CORS-safe video source for cross-origin videos
    let corsVideo: HTMLVideoElement | undefined;
    if (!posterImage) {
      try {
        corsVideo = await ensureCorsSafeSource(video);
      } catch {
        corsVideo = video;
      }
    }

    const state: IMediaOverlayState = {
      overlay,
      canvas,
      ctx,
      resizeObserver: new ResizeObserver(() => {}),
      cleanupObserver: new MutationObserver(() => {}),
      lastSize: { width: videoRect.width, height: videoRect.height },
      rafId: null,
      destroyed: false,
      currentPrediction: undefined,
      posterImage,
      corsVideo,
      masking,
    };

    renderVideoMask(
      canvas,
      ctx,
      allMasks,
      maskTransform,
      originalWidth,
      originalHeight,
      videoRect.width,
      videoRect.height,
      corsVideo || video,
      contentRect.offsetX,
      contentRect.offsetY,
      contentRect.width,
      contentRect.height,
      posterImage,
      masking,
    );

    this.videoStates.set(video, state);
    return state;
  }

  private setupObservers(video: HTMLVideoElement, state: IMediaOverlayState): void {
    // ResizeObserver to update overlay on video resize
    state.resizeObserver = new ResizeObserver(() => {
      this.updateVideoOverlay(video, state);
    });
    state.resizeObserver.observe(video);

    // Cleanup when the video is removed; re-home when a framework re-render
    // merely moved it (or dropped the overlay while keeping the video)
    state.cleanupObserver = new MutationObserver(mutations => {
      if (state.destroyed) return;
      const change = classifyOverlayMutation(mutations, video, state.overlay);
      if (change === 'none') return;
      if (change === 'detached') {
        this.clearMaskOverlay(video);
        return;
      }
      const parent = video.parentElement;
      if (parent && state.overlay.parentElement !== parent) {
        ensurePositionContext(parent);
        parent.appendChild(state.overlay);
      }
      this.updateVideoOverlay(video, state);
    });
    state.cleanupObserver.observe(document.body, { childList: true, subtree: true });

    // Viewport resize handler
    state.viewportHandler = () => {
      this.updateVideoOverlay(video, state);
    };
    globalThis.addEventListener('resize', state.viewportHandler);

    this.videoStates.set(video, state);
  }

  private updateVideoOverlay(video: HTMLVideoElement, state: IMediaOverlayState): void {
    if (state.destroyed) return;
    const { currentPrediction: prediction } = state;
    if (!prediction || !prediction.predictions?.length) return;

    // Coalesce updates to animation frames
    if (state.rafId != null) {
      cancelAnimationFrame(state.rafId);
    }

    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;

      const parent = video.parentElement;
      if (!parent) return;

      ensurePositionContext(parent);

      const videoRect = video.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const { overlay } = state;

      const needsResize = state.lastSize.width !== videoRect.width || state.lastSize.height !== videoRect.height;

      if (needsResize) {
        const offset = overlayOffsetInParent(parent, videoRect, parentRect);
        overlay.style.top = `${offset.top}px`;
        overlay.style.left = `${offset.left}px`;
        overlay.style.width = `${videoRect.width}px`;
        overlay.style.height = `${videoRect.height}px`;
        state.lastSize = { width: videoRect.width, height: videoRect.height };
      }

      // Collect masks
      const allMasks: { masks: number[][] }[] = [];
      prediction.predictions.forEach(p => {
        if (p.masks && p.masks.runs.length) {
          allMasks.push({ masks: decodeMaskRLE(p.masks) });
        }
      });
      if (!allMasks.length) return;

      const { maskTransform } = prediction;
      const originalWidth = prediction.width;
      const originalHeight = prediction.height;

      const { posterImage } = state;
      const contentRect = computeRenderedContentRectWithDimensions(
        video,
        videoRect,
        posterImage ? posterImage.naturalWidth : undefined,
        posterImage ? posterImage.naturalHeight : undefined,
      );

      renderVideoMask(
        state.canvas,
        state.ctx,
        allMasks,
        maskTransform,
        originalWidth,
        originalHeight,
        videoRect.width,
        videoRect.height,
        state.corsVideo || video,
        contentRect.offsetX,
        contentRect.offsetY,
        contentRect.width,
        contentRect.height,
        posterImage,
        state.masking,
      );
    });
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

/**
 * Overlays owned by a live state; the stale-overlay sweep must only remove
 * orphans, never a sibling video's live mask (several masked videos can share
 * one parent).
 */
const liveVideoOverlays = new WeakSet<HTMLDivElement>();

// Helper function for removing existing (orphaned) video overlays
function removeExistingVideoOverlays(parent: HTMLElement): void {
  const existingOverlays = parent.querySelectorAll('[data-video-mask-overlay]');
  existingOverlays.forEach(overlay => {
    if (!liveVideoOverlays.has(overlay as HTMLDivElement)) overlay.remove();
  });
}

/**
 * Compute rendered content rect with override dimensions.
 * This is needed when the source dimensions (e.g., poster) differ from video natural dimensions.
 */
function computeRenderedContentRectWithDimensions(
  video: HTMLVideoElement,
  videoRect: DOMRect,
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
