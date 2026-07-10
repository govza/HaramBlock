/**
 * DVR canvas presenter (docs/VIDEO_PROCESSING.md): presents buffered video
 * frames a fixed delay behind the live edge so every presented frame's verdict
 * is already resolved. Frame and mask are composited in the same draw — they
 * cannot desynchronize the way a DOM overlay chasing native playback can.
 *
 * Pure consumer of a FrameRing + VerdictTrack (the video analog of
 * gifMaskPlayer's decoded-frames + framePredictions): the session machine and
 * registry decide when it exists; the player only warms up, draws, and reports
 * readiness via onReady. Presentation is an overlay div injected next to the
 * video, one z-index above it, so player chrome stays on top. The rAF draw
 * loop also syncs geometry per tick — placement, size, and re-homing when the
 * site re-parents the player — instead of using observers.
 */

import { computeRenderedContentRect, maskGridSrcRect } from '@/entrypoints/content/presentation/imageLayout';
import {
  ensurePositionContext,
  overlayOffsetInParent,
  resolveInjectionContext,
} from '@/entrypoints/content/presentation/overlayPosition';
import { BRIDGE_HORIZON_SEC, type VerdictEntry, type VerdictTrack } from '@/entrypoints/content/video/dvr/verdictTrack';
import { logger } from '@/utils/logger';
import { buildCanvasTintFilter, buildMaskingFilter, calculatePixelationBlockSize } from '@/utils/masking';
import { decodeMaskRLE } from '@/utils/rle';

import type { FrameRing } from '@/entrypoints/content/video/dvr/frameRing';
import type { IMaskingSettings } from '@/utils/types';

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
  /**
   * Presentation delay D: the canvas presents mediaTime ≈ currentTime − D.
   * Read per tick — the registry adapts it to the session's observed
   * sample→verdict round-trips.
   */
  getDelaySec: () => number;
  /** Live view of the host masking settings (quick toggle may change them). */
  getMasking: () => IMaskingSettings;
  /** Fired once, when the canvas takes over (first buffered frame, pinned until the buffer spans D). */
  onReady: () => void;
}

interface DrawSurfaces {
  overlay: HTMLDivElement;
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
  private lastOffset = { top: NaN, left: NaN };
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
    this.teardown();
  }

  private teardown(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.surfaces) {
      this.surfaces.overlay.remove();
      this.surfaces = null;
      restoreOpacity(this.opts.video, this.originalOpacity);
    }
  }

  private readonly tick = (): void => {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.tick);
    try {
      if (!this.surfaces) {
        // Present from the very first buffered frame: instead of a whole-blur
        // warm-up, the viewer sees a masked "rebuffering" pause — the earliest
        // frame, pinned until the buffer reaches back D (see draw()).
        if (this.opts.ring.oldestTime() !== null) this.beginPresentation();
        return;
      }
      if (!this.syncGeometry()) return;
      this.draw();
    } catch (error) {
      log.error('DVR draw failed:', error);
    }
  };

  /** First frame buffered: inject the overlay, hide the native element, report readiness. */
  private beginPresentation(): void {
    const { video, onReady } = this.opts;
    // No container to inject into yet (mid re-render): retry next tick.
    if (!resolveInjectionContext(video)) return;

    const baseCanvas = document.createElement('canvas');
    const maskCanvas = document.createElement('canvas');
    for (const canvas of [baseCanvas, maskCanvas]) {
      canvas.style.cssText = CANVAS_STYLE;
    }
    const baseCtx = baseCanvas.getContext('2d');
    const maskCtx = maskCanvas.getContext('2d');
    if (!baseCtx || !maskCtx) {
      // Unrecoverable (2D context exhaustion): latch off, or every subsequent
      // tick would re-enter here and allocate two canvases per frame. The
      // machine stays in 'warming' under the whole-blur — still fail-closed.
      log.error('Failed to get DVR canvas context');
      this.teardown();
      return;
    }

    const overlay = document.createElement('div');
    overlay.setAttribute('data-video-dvr-player', 'video-dvr-player');
    overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    overflow: hidden;
    pointer-events: none;
  `;
    overlay.append(baseCanvas, maskCanvas);

    this.originalOpacity = video.style.opacity;
    video.style.setProperty('opacity', '0', 'important');
    this.surfaces = { overlay, baseCanvas, baseCtx, maskCanvas, maskCtx };

    // syncGeometry homes the overlay next to the video and sets lastSize
    // before the first draw.
    if (this.syncGeometry()) this.draw();

    // Report ready after the draw: the machine lifts the whole-blur on
    // bufferReady, and the swap must never expose an unpainted gap.
    onReady();
  }

  /**
   * Per-tick geometry sync: homes the overlay next to the video and keeps
   * offsets/size current. Returns whether the video is presentable this tick.
   */
  private syncGeometry(): boolean {
    const { video } = this.opts;
    const { surfaces } = this;
    if (!surfaces) return false;
    // The element left the document; the session's dispose path destroys us.
    if (!video.isConnected) {
      this.teardown();
      return false;
    }
    const context = resolveInjectionContext(video);
    if (!context) return false;

    if (surfaces.overlay.parentNode !== context.container) {
      ensurePositionContext(context.box);
      context.container.appendChild(surfaces.overlay);
      // One above the video, so player chrome above the video stays above the mask
      const videoZIndex = parseInt(getComputedStyle(video).zIndex) || 0;
      surfaces.overlay.style.zIndex = `${videoZIndex + 1}`;
    }

    const videoRect = video.getBoundingClientRect();
    const boxRect = context.box.getBoundingClientRect();
    const offset = overlayOffsetInParent(context.box, videoRect, boxRect);
    if (offset.top !== this.lastOffset.top || offset.left !== this.lastOffset.left) {
      this.lastOffset = offset;
      surfaces.overlay.style.top = `${offset.top}px`;
      surfaces.overlay.style.left = `${offset.left}px`;
    }
    if (videoRect.width !== this.lastSize.width || videoRect.height !== this.lastSize.height) {
      this.lastSize = { width: videoRect.width, height: videoRect.height };
      surfaces.overlay.style.width = `${videoRect.width}px`;
      surfaces.overlay.style.height = `${videoRect.height}px`;
      this.lastDrawKey = ''; // force a redraw at the new size
    }
    return this.lastSize.width > 0 && this.lastSize.height > 0;
  }

  private draw(): void {
    const { video, ring, track, getDelaySec, getMasking } = this.opts;
    const { surfaces } = this;
    if (!surfaces) return;
    const { width, height } = this.lastSize;
    if (width <= 0 || height <= 0) return;

    const delaySec = getDelaySec();
    // Clamped to the earliest buffered frame: while the buffer is still
    // shorter than D (warm-up, post-seek re-warm, loop restart), playback
    // holds on that frame — masked — until now − D reaches it, then runs.
    const oldest = ring.oldestTime();
    const targetTime = oldest === null ? video.currentTime - delaySec : Math.max(video.currentTime - delaySec, oldest);
    const frame = ring.frameAt(targetTime);
    track.prune(targetTime - TRACK_PRUNE_SLACK_SEC);
    const masking = getMasking();
    // When inference cannot keep up, stretch verdicts (inertia) further rather
    // than blurring: the bridge horizon scales with the observed round-trip.
    const bridgeHorizonSec = Math.max(BRIDGE_HORIZON_SEC, delaySec * 2);
    const verdict = frame
      ? track.verdictFor(frame.mediaTime, track.inertiaWindowSec(), bridgeHorizonSec)
      : ({ kind: 'none' } as const);

    // The 'none' fallback draws the live element, which changes every tick;
    // everything else redraws only when the frame, verdict, or size moved
    // (syncGeometry moves the overlay itself — position never forces a redraw).
    const drawKey =
      verdict.kind === 'none'
        ? ''
        : [
            frame?.mediaTime,
            verdict.kind,
            // Verdict identity, not just count: while pinned on the warm-up
            // frame, a newer verdict must refresh the mask geometry.
            verdict.kind === 'unsafe' ? verdict.entries.map(entry => entry.timestampSec).join(',') : '',
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
