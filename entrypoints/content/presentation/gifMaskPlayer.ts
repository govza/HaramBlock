import { GIF_MASK_OVERLAY_ATTR } from '@/entrypoints/content/presentation/constants';
import { MaskCoverage, paintPixelatedMask } from '@/entrypoints/content/presentation/maskCoverage';
import {
  anchorOverlay,
  type OverlayAnchor,
  type OverlayGeometry,
} from '@/entrypoints/content/presentation/overlayAnchor';
import {
  predictionToggleRegistration,
  registerQuickToggle,
  unregisterQuickToggle,
} from '@/entrypoints/content/presentation/quickToggle';
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

/**
 * One playing GIF: its anchored overlay with the decoded-frame and mask canvases, the frames and
 * per-frame predictions it cycles through, and the playback cursor.
 */
interface GifPlayerState {
  anchor: OverlayAnchor;
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
  destroyed: boolean;
  originalOpacity?: string;
}

const CANVAS_STYLE = `
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  `;

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

    const existing = gifStates.get(image);
    if (existing && !existing.destroyed) {
      existing.frames = frames;
      existing.framePredictions = framePredictions;
      existing.aggregatePrediction = aggregatePrediction;
      existing.hostSettings = hostSettings;
      existing.maskInertia = maskInertia;
      existing.anchor.refresh();
      return;
    }

    const overlay = document.createElement('div');
    overlay.setAttribute(GIF_MASK_OVERLAY_ATTR, 'animated-gif-mask-player');
    overlay.style.cssText = 'position: absolute; overflow: hidden; pointer-events: none;';

    const baseCanvas = document.createElement('canvas');
    baseCanvas.style.cssText = CANVAS_STYLE;
    const baseCtx = baseCanvas.getContext('2d');
    if (!baseCtx) {
      log.error('gif.canvas_context.failed', { canvas: 'base' });
      return;
    }

    const maskCanvas = document.createElement('canvas');
    maskCanvas.style.cssText = CANVAS_STYLE;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) {
      log.error('gif.canvas_context.failed', { canvas: 'mask' });
      return;
    }

    overlay.append(baseCanvas, maskCanvas);

    const state: GifPlayerState = {
      anchor: anchorOverlay(image, overlay, {
        trackSrc: true,
        onLayout: geometry => this.renderCurrentFrame(image, geometry),
        onLost: () => this.clearPlayer(image),
      }),
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
      destroyed: false,
      originalOpacity: image.style.opacity,
    };

    gifStates.set(image, state);
    image.style.setProperty('opacity', '0', 'important');
    this.play(state);
  }

  clearPlayer(image: HTMLImageElement, unregisterToggle = true): void {
    const state = gifStates.get(image);
    if (!state) {
      if (unregisterToggle) unregisterQuickToggle(image);
      return;
    }

    state.destroyed = true;
    if (state.timerId) clearTimeout(state.timerId);
    state.anchor.dispose();
    restoreOpacity(image, state.originalOpacity);
    gifStates.delete(image);
    if (unregisterToggle) unregisterQuickToggle(image);
  }

  hasPlayer(image: HTMLImageElement): boolean {
    return gifStates.has(image);
  }

  private play(state: GifPlayerState): void {
    if (state.destroyed) return;
    state.anchor.refresh();

    if (state.destroyed || state.frames.length <= 1) return;

    const current = state.frames[state.currentFrame];
    const durationMs = current?.durationMs ?? 100;
    state.timerId = setTimeout(() => {
      state.currentFrame = (state.currentFrame + 1) % state.frames.length;
      this.play(state);
    }, durationMs);
  }

  private renderCurrentFrame(image: HTMLImageElement, geometry: OverlayGeometry): void {
    const state = gifStates.get(image);
    const frame = state?.frames[state.currentFrame];
    if (!state || !frame || state.destroyed) return;

    const { width, height, content: contentRect } = geometry;
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
