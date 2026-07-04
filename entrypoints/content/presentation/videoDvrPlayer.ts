/**
 * DVR canvas presenter (docs/VIDEO_PROCESSING.md): presents buffered video
 * frames a fixed delay behind the live edge so every presented frame's verdict
 * is already resolved. Frame and mask are composited in the same draw — they
 * cannot desynchronize the way a DOM overlay chasing native playback can.
 *
 * Pure consumer of a FrameRing + VerdictTrack (the video analog of
 * gifMaskPlayer's decoded-frames + framePredictions): the session machine and
 * registry decide when it exists; the player only warms up, draws, and reports
 * readiness via onReady. Presentation lives in an overlay-layer slot
 * ('video-dvr-player'): the layer owns placement, clipping, occlusion, and
 * fullscreen; the player only draws at its own rAF cadence.
 */

import { computeRenderedContentRect, maskGridSrcRect } from '@/entrypoints/content/presentation/imageLayout';
import { overlayLayer } from '@/entrypoints/content/presentation/layer/overlayLayer';
import { logger } from '@/utils/logger';
import { buildCanvasTintFilter, buildMaskingFilter, calculatePixelationBlockSize } from '@/utils/masking';
import { decodeMaskRLE } from '@/utils/rle';

import type { FrameRing } from '@/entrypoints/content/video/dvr/frameRing';
import type { VerdictEntry, VerdictTrack } from '@/entrypoints/content/video/dvr/verdictTrack';
import type { IMaskingSettings } from '@/utils/types';
import type { IOverlaySlot } from '@/utils/types/presentation';

const log = logger.withTag('videoDvrPlayer');

/** Verdicts older than the presented time by more than this are unreachable; prune them. */
const TRACK_PRUNE_SLACK_SEC = 4;

const CANVAS_STYLE = [
  'position: absolute',
  'top: 0',
  'left: 0',
  'pointer-events: none',
  'image-rendering: pixelated',
  'image-rendering: crisp-edges',
].join('; ');

export interface VideoDvrPlayerOptions {
  video: HTMLVideoElement;
  ring: FrameRing;
  track: VerdictTrack;
  /** Presentation delay D: the canvas presents mediaTime ≈ currentTime − delaySec. */
  delaySec: number;
  /** Live view of the host masking settings (quick toggle may change them). */
  getMasking: () => IMaskingSettings;
  /** Fired once, when the buffer first spans delaySec and the canvas has taken over. */
  onReady: () => void;
}

interface DrawSurfaces {
  slot: IOverlaySlot;
  baseCanvas: HTMLCanvasElement;
  baseCtx: CanvasRenderingContext2D;
  maskCanvas: HTMLCanvasElement;
  maskCtx: CanvasRenderingContext2D;
}

export class VideoDvrPlayer {
  private rafId: number | null = null;
  private destroyed = false;
  private surfaces: DrawSurfaces | null = null;
  private originalOpacity: string | undefined;
  private lastSize = { width: 0, height: 0 };
  private lastDrawKey = '';
  /** RLE decode is expensive; each verdict entry's grid is rasterized once. */
  private readonly gridCache = new WeakMap<VerdictEntry, HTMLCanvasElement | null>();

  constructor(private readonly opts: VideoDvrPlayerOptions) {
    this.rafId = requestAnimationFrame(this.tick);
  }

  presenting(): boolean {
    return this.surfaces !== null;
  }

  destroy(): void {
    this.teardown({ releaseSlot: true });
  }

  private teardown(opts: { releaseSlot: boolean }): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.surfaces) {
      if (opts.releaseSlot) this.surfaces.slot.release();
      this.surfaces = null;
      restoreOpacity(this.opts.video, this.originalOpacity);
    }
  }

  private readonly tick = (): void => {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.tick);
    try {
      if (!this.surfaces) {
        if (this.opts.ring.spanSec() >= this.opts.delaySec) this.beginPresentation();
        return;
      }
      this.draw();
    } catch (error) {
      log.error('DVR draw failed:', error);
    }
  };

  /** The buffer is warm: take a layer slot, hide the native element, report readiness. */
  private beginPresentation(): void {
    const { video, onReady } = this.opts;

    const baseCanvas = document.createElement('canvas');
    const maskCanvas = document.createElement('canvas');
    for (const canvas of [baseCanvas, maskCanvas]) {
      canvas.style.cssText = CANVAS_STYLE;
    }
    const baseCtx = baseCanvas.getContext('2d');
    const maskCtx = maskCanvas.getContext('2d');
    if (!baseCtx || !maskCtx) {
      log.error('Failed to get DVR canvas context');
      return;
    }

    // The layer owns placement/clipping/occlusion/fullscreen; attach fires the
    // initial geometry synchronously, so lastSize is set before the first draw.
    const slot = overlayLayer.attach(
      video,
      {
        onGeometry: ({ rect }) => {
          if (rect.width === this.lastSize.width && rect.height === this.lastSize.height) return;
          this.lastSize = { width: rect.width, height: rect.height };
          this.lastDrawKey = ''; // force a redraw at the new size
        },
        // The element left the document: the slot is already released; the
        // session's dispose path will destroy() us — stop drawing now.
        onDetach: () => this.teardown({ releaseSlot: false }),
      },
      'video-dvr-player',
    );
    slot.root.append(baseCanvas, maskCanvas);

    this.originalOpacity = video.style.opacity;
    video.style.setProperty('opacity', '0', 'important');
    this.surfaces = { slot, baseCanvas, baseCtx, maskCanvas, maskCtx };

    // Draw before reporting ready: the machine lifts the whole-blur on
    // bufferReady, and the swap must never expose an unpainted gap.
    this.draw();
    onReady();
  }

  private draw(): void {
    const { video, ring, track, delaySec, getMasking } = this.opts;
    const { surfaces } = this;
    if (!surfaces) return;
    const { width, height } = this.lastSize;
    if (width <= 0 || height <= 0) return;

    const targetTime = video.currentTime - delaySec;
    const frame = ring.frameAt(targetTime);
    track.prune(targetTime - TRACK_PRUNE_SLACK_SEC);
    const masking = getMasking();
    const verdict = frame ? track.verdictFor(frame.mediaTime, track.inertiaWindowSec()) : ({ kind: 'none' } as const);

    // The 'none' fallback draws the live element, which changes every tick;
    // everything else redraws only when the frame, verdict, or size moved
    // (the layer moves the slot itself — position is not the player's concern).
    const drawKey =
      verdict.kind === 'none'
        ? ''
        : [
            frame?.mediaTime,
            verdict.kind,
            verdict.kind === 'unsafe' ? verdict.entries.length : 0,
            width,
            height,
            masking.pixelationScale,
          ].join('|');
    if (drawKey && drawKey === this.lastDrawKey) return;
    this.lastDrawKey = drawKey;

    const { baseCanvas, baseCtx, maskCanvas, maskCtx } = surfaces;
    resizeCanvas(baseCanvas, width, height);
    resizeCanvas(maskCanvas, width, height);

    const content = computeRenderedContentRect(video, this.lastSize);

    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

    if (!frame || verdict.kind === 'none') {
      // Verdict not resolved yet (or the buffer cannot reach back D): present
      // the live frame whole-blurred. Fail-closed without ever pausing.
      // Drawing a cross-origin video only taints the canvas — display still works.
      baseCtx.drawImage(video, content.offsetX, content.offsetY, content.width, content.height);
      baseCanvas.style.filter = buildMaskingFilter(masking);
      maskCanvas.style.filter = '';
      return;
    }

    baseCanvas.style.filter = '';
    baseCtx.drawImage(
      frame.bitmap,
      0,
      0,
      frame.bitmap.width,
      frame.bitmap.height,
      content.offsetX,
      content.offsetY,
      content.width,
      content.height,
    );

    if (verdict.kind === 'unsafe') {
      this.renderMasks(frame.bitmap, verdict.entries, content, masking);
    } else {
      maskCanvas.style.filter = '';
    }
  }

  /**
   * Same technique as the GIF player: pixelate the frame into the content
   * rect, then destination-in with the union of all in-window mask grids.
   */
  private renderMasks(
    frameBitmap: ImageBitmap,
    entries: VerdictEntry[],
    content: { offsetX: number; offsetY: number; width: number; height: number },
    masking: IMaskingSettings,
  ): void {
    const { surfaces } = this;
    if (!surfaces || content.width <= 0 || content.height <= 0) return;
    const { maskCanvas, maskCtx } = surfaces;

    const blockSize = calculatePixelationBlockSize(masking.pixelationScale);
    const smallW = Math.max(1, Math.floor(content.width / blockSize));
    const smallH = Math.max(1, Math.floor(content.height / blockSize));
    const tmp = document.createElement('canvas');
    tmp.width = smallW;
    tmp.height = smallH;
    const tmpCtx = tmp.getContext('2d');
    if (!tmpCtx) return;
    tmpCtx.imageSmoothingEnabled = true;
    tmpCtx.drawImage(frameBitmap, 0, 0, frameBitmap.width, frameBitmap.height, 0, 0, smallW, smallH);

    maskCtx.imageSmoothingEnabled = false;
    maskCtx.drawImage(tmp, content.offsetX, content.offsetY, content.width, content.height);

    const union = document.createElement('canvas');
    union.width = maskCanvas.width;
    union.height = maskCanvas.height;
    const unionCtx = union.getContext('2d');
    if (!unionCtx) return;
    unionCtx.imageSmoothingEnabled = false;

    let anyMask = false;
    for (const entry of entries) {
      const grid = this.gridFor(entry);
      if (!grid) continue;
      anyMask = true;
      const { srcX, srcY, srcW, srcH } = maskGridSrcRect(entry.maskTransform, entry.width, entry.height);
      unionCtx.drawImage(grid, srcX, srcY, srcW, srcH, content.offsetX, content.offsetY, content.width, content.height);
    }
    if (!anyMask) {
      maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      return;
    }

    maskCtx.globalCompositeOperation = 'destination-in';
    maskCtx.drawImage(union, 0, 0);
    maskCtx.globalCompositeOperation = 'source-over';
    maskCanvas.style.filter = buildCanvasTintFilter(masking);
  }

  private gridFor(entry: VerdictEntry): HTMLCanvasElement | null {
    if (this.gridCache.has(entry)) return this.gridCache.get(entry) ?? null;
    const grid = rasterizeMaskGrid(entry);
    this.gridCache.set(entry, grid);
    return grid;
  }
}

/** Decode an entry's RLE masks once into a grid-resolution canvas of opaque pixels. */
function rasterizeMaskGrid(entry: VerdictEntry): HTMLCanvasElement | null {
  const decoded = entry.predictions
    .filter(prediction => prediction.masks?.runs?.length)
    .map(prediction => decodeMaskRLE(prediction.masks));
  const first = decoded.find(masks => masks.length);
  const gridH = first?.length ?? 0;
  const gridW = first?.[0]?.length ?? 0;
  if (!gridW || !gridH) return null;

  const grid = document.createElement('canvas');
  grid.width = gridW;
  grid.height = gridH;
  const ctx = grid.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = 'rgba(0,0,0,1)';
  for (const masks of decoded) {
    if (masks.length !== gridH || masks[0]?.length !== gridW) continue;
    for (let y = 0; y < gridH; y++) {
      const row = masks[y];
      if (!row) continue;
      for (let x = 0; x < gridW; x++) {
        const value = row[x];
        if (typeof value === 'number' && value > 0.5) {
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }
  return grid;
}

function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  const canvasWidth = Math.max(1, Math.round(width));
  const canvasHeight = Math.max(1, Math.round(height));
  if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
  if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

function restoreOpacity(video: HTMLVideoElement, originalOpacity: string | undefined): void {
  if (originalOpacity) {
    video.style.opacity = originalOpacity;
  } else {
    video.style.removeProperty('opacity');
  }
}
