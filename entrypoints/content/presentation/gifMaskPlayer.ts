import { GIF_MASK_OVERLAY_ATTR } from '@/entrypoints/content/presentation/constants';
import { computeRenderedContentRect, maskGridSrcRect } from '@/entrypoints/content/presentation/imageLayout';
import {
  classifyOverlayMutation,
  ensurePositionContext,
  overlayOffsetInParent,
  resolveAnchorParent,
} from '@/entrypoints/content/presentation/overlayPosition';
import {
  predictionToggleRegistration,
  registerQuickToggle,
  unregisterQuickToggle,
} from '@/entrypoints/content/presentation/quickToggle';
import { notifySrcDrift } from '@/entrypoints/content/presentation/srcDrift';
import { logger } from '@/utils/logger';
import { buildCanvasTintFilter, buildMaskingFilter, calculatePixelationBlockSize } from '@/utils/masking';
import { decodeMaskRLE, type IRLEMask } from '@/utils/rle';
import {
  shouldBlock,
  type IElementPrediction,
  type IGifFramePrediction,
  type IHostSettings,
  type IMaskTransform,
  type IMaskingSettings,
} from '@/utils/types';

import type { DecodedGifFrame } from '@/entrypoints/content/gif/gifDecoder';

type GifPrediction = Omit<IGifFramePrediction, 'maskTransform'> & {
  maskTransform?: IMaskTransform;
  forcedVisibility?: never;
};

interface GifPlayerState {
  overlay: HTMLDivElement;
  baseCanvas: HTMLCanvasElement;
  baseCtx: CanvasRenderingContext2D;
  maskCanvas: HTMLCanvasElement;
  maskCtx: CanvasRenderingContext2D;
  frames: DecodedGifFrame[];
  framePredictions: Map<number, GifPrediction>;
  aggregatePrediction: Parameters<typeof shouldBlock>[0];
  hostSettings: IHostSettings;
  maskInertia: number;
  currentFrame: number;
  timerId?: ReturnType<typeof setTimeout>;
  resizeObserver: ResizeObserver;
  cleanupObserver: MutationObserver;
  viewportHandler: () => void;
  destroyed: boolean;
  originalOpacity?: string;
  trackedSrc: string;
}

const gifStates = new WeakMap<HTMLImageElement, GifPlayerState>();

class GifMaskPlayer {
  createOrUpdatePlayer(
    image: HTMLImageElement,
    frames: DecodedGifFrame[],
    framePredictions: Map<number, IGifFramePrediction>,
    aggregatePrediction: Parameters<typeof shouldBlock>[0],
    hostSettings: IHostSettings,
    maskInertia: number,
  ): void {
    registerQuickToggle(image, predictionToggleRegistration(aggregatePrediction, hostSettings));

    if (!frames.length || !shouldBlock(aggregatePrediction)) {
      this.clearPlayer(image, false);
      return;
    }

    const parent = resolveAnchorParent(image);
    if (!parent) return;

    ensurePositionContext(parent);

    const existing = gifStates.get(image);
    if (existing && !existing.destroyed) {
      existing.frames = frames;
      existing.framePredictions = framePredictions;
      existing.aggregatePrediction = aggregatePrediction;
      existing.hostSettings = hostSettings;
      existing.maskInertia = maskInertia;
      this.renderCurrentFrame(image, existing);
      return;
    }

    const imageRect = image.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const offset = overlayOffsetInParent(parent, imageRect, parentRect);
    const overlay = document.createElement('div');
    overlay.setAttribute(GIF_MASK_OVERLAY_ATTR, 'animated-gif-mask-player');

    overlay.style.cssText = `
      position: absolute;
      top: ${offset.top}px;
      left: ${offset.left}px;
      width: ${imageRect.width}px;
      height: ${imageRect.height}px;
      overflow: hidden;
      pointer-events: none;
    `;
    const imageZIndex = getComputedStyle(image).zIndex;
    if (imageZIndex !== 'auto') {
      overlay.style.zIndex = imageZIndex;
    }

    const baseCanvas = document.createElement('canvas');
    baseCanvas.style.cssText = canvasStyle(imageRect.width, imageRect.height);
    const baseCtx = baseCanvas.getContext('2d');
    if (!baseCtx) {
      logger.withTag('gifMaskPlayer').error('Failed to get GIF base canvas context');
      return;
    }

    const maskCanvas = document.createElement('canvas');
    maskCanvas.style.cssText = canvasStyle(imageRect.width, imageRect.height);
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) {
      logger.withTag('gifMaskPlayer').error('Failed to get GIF mask canvas context');
      return;
    }

    overlay.append(baseCanvas, maskCanvas);
    image.after(overlay);

    const state: GifPlayerState = {
      overlay,
      baseCanvas,
      baseCtx,
      maskCanvas,
      maskCtx,
      frames,
      framePredictions,
      aggregatePrediction,
      hostSettings,
      maskInertia,
      currentFrame: 0,
      resizeObserver: new ResizeObserver(() => this.updateLayout(image)),
      cleanupObserver: new MutationObserver(mutations => {
        const change = classifyOverlayMutation(mutations, image, overlay);
        if (change === 'none') return;
        if (change === 'detached') {
          this.clearPlayer(image);
          return;
        }
        // moved: the player overlay lives as the image's next sibling
        const anchor = resolveAnchorParent(image);
        if (anchor && (overlay.previousElementSibling !== image || !overlay.isConnected)) {
          ensurePositionContext(anchor);
          image.after(overlay);
          gifStates.get(image)?.resizeObserver.observe(anchor);
        }
        this.updateLayout(image);
      }),
      viewportHandler: () => this.updateLayout(image),
      destroyed: false,
      originalOpacity: image.style.opacity,
      trackedSrc: image.currentSrc || image.src,
    };

    gifStates.set(image, state);
    image.style.setProperty('opacity', '0', 'important');
    state.resizeObserver.observe(image);
    // Parent size changes move the image's offsets within it even when the
    // image size does not (flex re-centering, custom-element upgrade)
    state.resizeObserver.observe(parent);
    state.cleanupObserver.observe(document.body, { childList: true, subtree: true });
    globalThis.addEventListener('resize', state.viewportHandler);
    globalThis.addEventListener('scroll', state.viewportHandler, { passive: true });

    this.play(image, state);
  }

  clearPlayer(image: HTMLImageElement, unregisterToggle = true): void {
    const state = gifStates.get(image);
    if (!state) {
      if (unregisterToggle) unregisterQuickToggle(image);
      return;
    }

    state.destroyed = true;
    if (state.timerId) clearTimeout(state.timerId);
    try {
      state.resizeObserver.disconnect();
      state.cleanupObserver.disconnect();
    } catch {
      // no-op
    }
    globalThis.removeEventListener('resize', state.viewportHandler);
    globalThis.removeEventListener('scroll', state.viewportHandler);
    state.overlay.remove();
    restoreOpacity(image, state.originalOpacity);
    gifStates.delete(image);
    if (unregisterToggle) unregisterQuickToggle(image);
  }

  hasPlayer(image: HTMLImageElement): boolean {
    return gifStates.has(image);
  }

  private play(image: HTMLImageElement, state: GifPlayerState): void {
    if (state.destroyed) return;
    this.renderCurrentFrame(image, state);

    if (state.frames.length <= 1) return;

    const current = state.frames[state.currentFrame];
    const durationMs = current?.durationMs ?? 100;
    state.timerId = setTimeout(() => {
      state.currentFrame = (state.currentFrame + 1) % state.frames.length;
      this.play(image, state);
    }, durationMs);
  }

  private updateLayout(image: HTMLImageElement): void {
    const state = gifStates.get(image);
    if (!state || state.destroyed) return;

    const currentSrc = image.currentSrc || image.src;
    if (currentSrc !== state.trackedSrc) {
      this.clearPlayer(image);
      notifySrcDrift(image);
      return;
    }

    this.renderCurrentFrame(image, state);
  }

  private renderCurrentFrame(image: HTMLImageElement, state: GifPlayerState): void {
    const frame = state.frames[state.currentFrame];
    const parent = resolveAnchorParent(image);
    if (!frame || !parent || state.destroyed) return;

    ensurePositionContext(parent);

    const imageRect = image.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const contentRect = computeRenderedContentRect(image, imageRect);
    const offset = overlayOffsetInParent(parent, imageRect, parentRect);

    state.overlay.style.top = `${offset.top}px`;
    state.overlay.style.left = `${offset.left}px`;
    state.overlay.style.width = `${imageRect.width}px`;
    state.overlay.style.height = `${imageRect.height}px`;

    resizeCanvas(state.baseCanvas, imageRect.width, imageRect.height);
    resizeCanvas(state.maskCanvas, imageRect.width, imageRect.height);

    state.baseCtx.clearRect(0, 0, state.baseCanvas.width, state.baseCanvas.height);
    state.baseCtx.drawImage(
      frame.bitmap,
      0,
      0,
      frame.bitmap.width,
      frame.bitmap.height,
      contentRect.offsetX,
      contentRect.offsetY,
      contentRect.width,
      contentRect.height,
    );

    state.maskCtx.clearRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
    state.maskCanvas.style.filter = '';
    state.baseCanvas.style.filter = '';

    if (state.aggregatePrediction.forcedVisibility === 'blocked') {
      state.baseCanvas.style.filter = buildMaskingFilter(state.hostSettings.masking);
      return;
    }

    const framePrediction = buildFramePredictionWithInertia(state, state.currentFrame);
    if (!framePrediction) return;

    renderSegmentMaskOverlay(
      state.maskCanvas,
      state.maskCtx,
      frame.bitmap,
      framePrediction.predictions,
      framePrediction.maskTransform ?? createIdentityMaskTransform(framePrediction),
      framePrediction.width,
      framePrediction.height,
      contentRect.offsetX,
      contentRect.offsetY,
      contentRect.width,
      contentRect.height,
      state.hostSettings.masking,
    );
  }
}

function buildFramePredictionWithInertia(state: GifPlayerState, currentFrame: number): GifPrediction | undefined {
  const current = state.frames[currentFrame];
  const exact = current ? state.framePredictions.get(current.frameIndex) : undefined;
  const predictions: IElementPrediction[] = [];
  let basePrediction: GifPrediction | undefined = hasDetections(exact) ? exact : undefined;

  if (hasDetections(exact)) {
    predictions.push(...exact.predictions);
  }

  const inertia = Math.max(1, state.maskInertia);
  for (let distance = 1; distance <= inertia; distance++) {
    const previousFrame = state.frames[currentFrame - distance];
    const previousPrediction = previousFrame ? state.framePredictions.get(previousFrame.frameIndex) : undefined;
    if (hasDetections(previousPrediction)) {
      basePrediction ??= previousPrediction;
      predictions.push(...previousPrediction.predictions);
    }

    const nextFrame = state.frames[currentFrame + distance];
    const nextPrediction = nextFrame ? state.framePredictions.get(nextFrame.frameIndex) : undefined;
    if (hasDetections(nextPrediction)) {
      basePrediction ??= nextPrediction;
      predictions.push(...nextPrediction.predictions);
    }
  }

  if (!basePrediction || !predictions.length) return undefined;
  return { ...basePrediction, predictions };
}

function hasDetections(prediction: GifPrediction | undefined): prediction is GifPrediction {
  return Boolean(prediction?.predictions.length);
}

function createIdentityMaskTransform(prediction: GifPrediction): IMaskTransform {
  const firstMask = prediction.predictions.find(p => p.masks?.runs?.length)?.masks;
  const fallbackWidth = prediction.width || 1;
  const fallbackHeight = prediction.height || 1;
  return {
    scaleX: prediction.width / (firstMask?.width ?? fallbackWidth),
    scaleY: prediction.height / (firstMask?.height ?? fallbackHeight),
    offsetX: 0,
    offsetY: 0,
  };
}

function canvasStyle(width: number, height: number): string {
  return `
    position: absolute;
    top: 0;
    left: 0;
    width: ${width}px;
    height: ${height}px;
    pointer-events: none;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  `;
}

function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  const canvasWidth = Math.max(1, Math.round(width));
  const canvasHeight = Math.max(1, Math.round(height));
  if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
  if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

function hasValidMask(prediction: IElementPrediction): prediction is IElementPrediction & { masks: IRLEMask } {
  return Boolean(prediction.masks?.runs?.length);
}

function renderSegmentMaskOverlay(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  source: ImageBitmap,
  predictions: IElementPrediction[],
  maskTransform: IMaskTransform,
  originalWidth: number,
  originalHeight: number,
  offsetXInOverlay: number,
  offsetYInOverlay: number,
  contentWidth: number,
  contentHeight: number,
  masking: IMaskingSettings,
): void {
  if (contentWidth <= 0 || contentHeight <= 0) return;

  const allMasks = predictions.filter(hasValidMask).map(prediction => ({
    masks: decodeMaskRLE(prediction.masks),
  }));
  const first = allMasks.find(m => m.masks.length);
  const gridH = first?.masks.length ?? 0;
  const gridW = first?.masks[0]?.length ?? 0;
  if (!gridW || !gridH) return;

  const blockSize = calculatePixelationBlockSize(masking.pixelationScale);
  const smallW = Math.max(1, Math.floor(contentWidth / blockSize));
  const smallH = Math.max(1, Math.floor(contentHeight / blockSize));

  const tmp = document.createElement('canvas');
  tmp.width = smallW;
  tmp.height = smallH;
  const tmpCtx = tmp.getContext('2d');
  if (!tmpCtx) return;

  tmpCtx.imageSmoothingEnabled = true;
  tmpCtx.drawImage(source, 0, 0, source.width, source.height, 0, 0, smallW, smallH);

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, offsetXInOverlay, offsetYInOverlay, contentWidth, contentHeight);

  const maskGrid = document.createElement('canvas');
  maskGrid.width = gridW;
  maskGrid.height = gridH;
  const maskGridCtx = maskGrid.getContext('2d');
  if (!maskGridCtx) return;

  maskGridCtx.fillStyle = 'rgba(0,0,0,1)';
  for (const { masks } of allMasks) {
    if (masks.length !== gridH || masks[0]?.length !== gridW) continue;
    for (let y = 0; y < gridH; y++) {
      const row = masks[y];
      if (!row) continue;
      for (let x = 0; x < gridW; x++) {
        const value = row[x];
        if (typeof value === 'number' && value > 0.5) {
          maskGridCtx.fillRect(x, y, 1, 1);
        }
      }
    }
  }

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return;

  const { srcX, srcY, srcW, srcH } = maskGridSrcRect(maskTransform, originalWidth, originalHeight);
  maskCtx.imageSmoothingEnabled = false;
  maskCtx.drawImage(maskGrid, srcX, srcY, srcW, srcH, offsetXInOverlay, offsetYInOverlay, contentWidth, contentHeight);

  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  canvas.style.filter = buildCanvasTintFilter(masking);
}

function restoreOpacity(image: HTMLImageElement, originalOpacity: string | undefined): void {
  if (originalOpacity) {
    image.style.opacity = originalOpacity;
  } else {
    image.style.removeProperty('opacity');
  }
}

export const gifMaskPlayer = new GifMaskPlayer();
