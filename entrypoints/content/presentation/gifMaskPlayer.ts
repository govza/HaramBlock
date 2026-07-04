import { computeRenderedContentRect, maskGridSrcRect } from '@/entrypoints/content/presentation/imageLayout';
import { overlayLayer } from '@/entrypoints/content/presentation/layer/overlayLayer';
import { registerQuickToggle, unregisterQuickToggle } from '@/entrypoints/content/presentation/quickToggle';
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
import type { ILayerGeometry, IOverlaySlot } from '@/utils/types/presentation';

type GifPrediction = Omit<IGifFramePrediction, 'maskTransform'> & {
  maskTransform?: IMaskTransform;
  forcedVisibility?: never;
};

interface GifPlayerState {
  slot: IOverlaySlot;
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
  lastSize: { width: number; height: number };
  timerId?: ReturnType<typeof setTimeout>;
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
    registerQuickToggle(image, aggregatePrediction, hostSettings);

    if (!frames.length || !shouldBlock(aggregatePrediction)) {
      this.clearPlayer(image, false);
      return;
    }

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

    const baseCanvas = document.createElement('canvas');
    baseCanvas.style.cssText = CANVAS_STYLE;
    const baseCtx = baseCanvas.getContext('2d');
    if (!baseCtx) {
      logger.withTag('gifMaskPlayer').error('Failed to get GIF base canvas context');
      return;
    }

    const maskCanvas = document.createElement('canvas');
    maskCanvas.style.cssText = CANVAS_STYLE;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) {
      logger.withTag('gifMaskPlayer').error('Failed to get GIF mask canvas context');
      return;
    }

    const state: GifPlayerState = {
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
      lastSize: { width: 0, height: 0 },
      destroyed: false,
      originalOpacity: image.style.opacity,
      trackedSrc: image.currentSrc || image.src,
      // assigned below; attach() fires the initial geometry callback synchronously
      // and the callback does not touch state.slot
      slot: undefined as unknown as IOverlaySlot,
    };
    gifStates.set(image, state);

    state.slot = overlayLayer.attach(image, {
      onGeometry: geometry => this.handleGeometry(image, state, geometry),
      onDetach: () => this.teardown(image, state, { releaseSlot: false }),
    });
    state.slot.root.append(baseCanvas, maskCanvas);

    // The native <img> keeps animating underneath; hide it so only the masked replay shows.
    image.style.setProperty('opacity', '0', 'important');

    this.play(image, state);
  }

  clearPlayer(image: HTMLImageElement, unregisterToggle = true): void {
    const state = gifStates.get(image);
    if (!state) {
      if (unregisterToggle) unregisterQuickToggle(image);
      return;
    }
    this.teardown(image, state, { releaseSlot: true });
    if (unregisterToggle) unregisterQuickToggle(image);
  }

  hasPlayer(image: HTMLImageElement): boolean {
    return gifStates.has(image);
  }

  private teardown(image: HTMLImageElement, state: GifPlayerState, opts: { releaseSlot: boolean }): void {
    state.destroyed = true;
    if (state.timerId) clearTimeout(state.timerId);
    if (opts.releaseSlot) state.slot?.release();
    restoreOpacity(image, state.originalOpacity);
    gifStates.delete(image);
  }

  private handleGeometry(image: HTMLImageElement, state: GifPlayerState, { rect }: ILayerGeometry): void {
    if (state.destroyed) return;

    const currentSrc = image.currentSrc || image.src;
    if (currentSrc !== state.trackedSrc) {
      this.clearPlayer(image);
      return;
    }

    // The layer already moved the slot; only a size change requires a redraw.
    if (rect.width === state.lastSize.width && rect.height === state.lastSize.height) return;
    state.lastSize = { width: rect.width, height: rect.height };
    this.renderCurrentFrame(image, state);
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

  private renderCurrentFrame(image: HTMLImageElement, state: GifPlayerState): void {
    const frame = state.frames[state.currentFrame];
    if (!frame || state.destroyed) return;

    const { width, height } = state.lastSize;
    if (width <= 0 || height <= 0) return;

    const contentRect = computeRenderedContentRect(image, state.lastSize);

    resizeCanvas(state.baseCanvas, width, height);
    resizeCanvas(state.maskCanvas, width, height);

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

const CANVAS_STYLE = [
  'position: absolute',
  'top: 0',
  'left: 0',
  'pointer-events: none',
  'image-rendering: pixelated',
  'image-rendering: crisp-edges',
].join('; ');

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
