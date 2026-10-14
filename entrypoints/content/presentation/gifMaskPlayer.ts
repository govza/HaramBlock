import { resolveImageSource } from '@/entrypoints/content/core/imageSource';
import { GIF_MASK_OVERLAY_ATTR } from '@/entrypoints/content/presentation/constants';
import { computeRenderedContentRect } from '@/entrypoints/content/presentation/imageLayout';
import { MaskCoverage, paintPixelatedMask } from '@/entrypoints/content/presentation/maskCoverage';
import {
  classifyOverlayMutation,
  ensurePositionContext,
  overlayPlacement,
  resolveAnchorParent,
} from '@/entrypoints/content/presentation/overlayPosition';
import {
  predictionToggleRegistration,
  registerQuickToggle,
  unregisterQuickToggle,
} from '@/entrypoints/content/presentation/quickToggle';
import { notifySrcDrift } from '@/entrypoints/content/presentation/srcDrift';
import { croppedMaskTransform } from '@/utils/croppedMaskTransform';
import { buildMaskingFilter } from '@/utils/masking';
import { getLogger } from '@/utils/telemetry';
import {
  shouldBlock,
  type IElementPrediction,
  type IGifFramePrediction,
  type IHostSettings,
  type IMaskTransform,
} from '@/utils/types';

import type { DecodedGifFrame } from '@/entrypoints/content/gif/gifDecoder';

const log = getLogger('gifMaskPlayer');

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
    const placement = overlayPlacement(image, parent, imageRect, parentRect);
    const overlay = document.createElement('div');
    overlay.setAttribute(GIF_MASK_OVERLAY_ATTR, 'animated-gif-mask-player');

    overlay.style.cssText = `
      position: ${placement.position};
      top: ${placement.top}px;
      left: ${placement.left}px;
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
      log.error('gif.canvas_context.failed', { canvas: 'base' });
      return;
    }

    const maskCanvas = document.createElement('canvas');
    maskCanvas.style.cssText = canvasStyle(imageRect.width, imageRect.height);
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) {
      log.error('gif.canvas_context.failed', { canvas: 'mask' });
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
      trackedSrc: resolveImageSource(image),
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

    const currentSrc = resolveImageSource(image);
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
    const placement = overlayPlacement(image, parent, imageRect, parentRect);

    state.overlay.style.position = placement.position;
    state.overlay.style.top = `${placement.top}px`;
    state.overlay.style.left = `${placement.left}px`;
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

    const coverage = MaskCoverage.from(
      framePrediction.predictions,
      framePrediction.maskTransform ??
        croppedMaskTransform(framePrediction.predictions, framePrediction.width, framePrediction.height),
      framePrediction.width,
      framePrediction.height,
    );
    if (!coverage) return;
    paintPixelatedMask(state.maskCtx, frame.bitmap, coverage, contentRect, state.hostSettings.masking);
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

function restoreOpacity(image: HTMLImageElement, originalOpacity: string | undefined): void {
  if (originalOpacity) {
    image.style.opacity = originalOpacity;
  } else {
    image.style.removeProperty('opacity');
  }
}

export const gifMaskPlayer = new GifMaskPlayer();
