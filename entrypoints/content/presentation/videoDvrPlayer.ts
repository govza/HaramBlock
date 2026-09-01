/**
 * DVR canvas presenter (docs/VIDEO_PROCESSING.md): presents buffered video
 * frames a fixed delay behind the live edge so every presented frame's verdict
 * is already resolved. Frame and mask are composited in the same draw — they
 * cannot desynchronize the way a DOM overlay chasing native playback can.
 *
 * Pure consumer of a DvrFrameStore + VerdictTimeline (the video analog of
 * gifMaskPlayer's decoded-frames + framePredictions): the session machine and
 * registry decide when it exists; the player only warms up, draws, and reports
 * readiness via onReady. Presentation is an overlay div injected as the
 * video's next sibling with the video's own z-index, so player chrome stacked
 * over the video stays on top of the mask too. The rAF draw
 * loop also syncs geometry per tick — placement, size, and re-homing when the
 * site re-parents the player — instead of using observers.
 */

import { DVR_OVERLAY_ATTR } from '@/entrypoints/content/presentation/constants';
import { computeRenderedContentRect, maskGridSrcRect } from '@/entrypoints/content/presentation/imageLayout';
import {
  ensurePositionContext,
  homeOverlay,
  overlayHomed,
  overlayPlacement,
  resolveInjectionContext,
} from '@/entrypoints/content/presentation/overlayPosition';
import { drainTargetTime, startDrainClock, type DrainClock } from '@/entrypoints/content/video/dvr/drain';
import {
  BRIDGE_HORIZON_SEC,
  type VerdictEntry,
  type VerdictTimeline,
} from '@/entrypoints/content/video/dvr/verdictTimeline';
import { buildCanvasTintFilter, buildMaskingFilter, calculatePixelationBlockSize } from '@/utils/masking';
import { decodeMaskRLE } from '@/utils/rle';
import { getLogger } from '@/utils/telemetry';

import type { DvrFrameStore, PresentableFrame } from '@/entrypoints/content/video/dvr/frameStore';
import type { IMaskingSettings } from '@/utils/types';

const log = getLogger('videoDvrPlayer');

/**
 * The verdict-less fallback draws the live element whole-blurred, so per-frame
 * fidelity buys nothing: cap its redraws at the ring's capture cadence instead
 * of every rAF tick.
 */
const NONE_REDRAWS_PER_SEC = 30;

/** Presented-clock catch-up margin: 5% is imperceptible, a snap is not. */
const PRESENTED_CATCH_UP_RATE = 1.05;

/**
 * The base canvas scales smoothly: buffered frames below display resolution
 * (budget degradation) must interpolate, not nearest-neighbour into visible
 * blocks. The mask canvas keeps pixelated scaling — its blockiness is the
 * masking effect itself.
 */
const CANVAS_STYLE = ['position: absolute', 'top: 0', 'left: 0', 'pointer-events: none'].join('; ');
const MASK_CANVAS_STYLE = [CANVAS_STYLE, 'image-rendering: pixelated', 'image-rendering: crisp-edges'].join('; ');

export interface VideoDvrPlayerOptions {
  video: HTMLVideoElement;
  store: DvrFrameStore;
  /** Session-lifetime verdict history; the player only reads it. */
  timeline: VerdictTimeline;
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
  private hidNativeVideo = false;
  private lastSize = { width: 0, height: 0 };
  private lastOffset = { top: NaN, left: NaN };
  private lastDrawKey = '';
  /** A buffered frame has been presented: the canvases hold real content a covered miss can pin. */
  private hasPresentedFrame = false;
  private presentedFrameCount = 0;
  private lastPresentedMediaTime = Number.NEGATIVE_INFINITY;
  private presentedClockSec: number | null = null;
  private lastTickWallSec: number | null = null;
  /** RLE decode is expensive; each verdict entry's grid is rasterized once. */
  private readonly gridCache = new WeakMap<VerdictEntry, HTMLCanvasElement | null>();
  /** Scratch canvases for renderMasks, reused across draws instead of allocated per frame. */
  private readonly pixelateScratch = document.createElement('canvas');
  private readonly unionScratch = document.createElement('canvas');
  /** Set once playback ends: the presented clock runs on wall time through the ring tail. */
  private drainClock: DrainClock | null = null;

  constructor(private readonly opts: VideoDvrPlayerOptions) {
    this.rafId = requestAnimationFrame(this.tick);
  }

  presenting(): boolean {
    return this.surfaces !== null;
  }

  /**
   * Playback ended: `video.currentTime` stops advancing, so the draw loop can
   * no longer derive its position from the media clock. Latch a wall-time
   * clock at the frozen presented position; draw() consumes the buffered tail
   * at 1x from there and holds the final frame. Seek, source change, and
   * dispose all destroy this player, which aborts the drain with it.
   */
  startDrain(): void {
    if (this.destroyed || this.drainClock) return;
    const { video, store, getDelaySec } = this.opts;
    this.drainClock = startDrainClock(
      clampToOldest(video.currentTime - getDelaySec(), store.oldestTime()),
      performance.now() / 1000,
    );
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
      if (this.hidNativeVideo) restoreOpacity(this.opts.video, this.originalOpacity);
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
        if (this.opts.store.oldestTime() !== null) this.beginPresentation();
        return;
      }
      if (!this.syncGeometry()) return;
      this.draw();
    } catch (error) {
      log.error('dvr.draw.failed', { error });
    }
  };

  /** First frame buffered: inject the overlay, hide the native element, report readiness. */
  private beginPresentation(): void {
    const { video, onReady } = this.opts;
    // No container to inject into yet (mid re-render): retry next tick.
    if (!resolveInjectionContext(video)) return;

    const baseCanvas = document.createElement('canvas');
    baseCanvas.style.cssText = CANVAS_STYLE;
    const maskCanvas = document.createElement('canvas');
    maskCanvas.style.cssText = MASK_CANVAS_STYLE;
    const baseCtx = baseCanvas.getContext('2d');
    const maskCtx = maskCanvas.getContext('2d');
    if (!baseCtx || !maskCtx) {
      // Unrecoverable (2D context exhaustion): latch off, or every subsequent
      // tick would re-enter here and allocate two canvases per frame. The
      // machine stays in 'warming' under the whole-blur — still fail-closed.
      log.error('dvr.canvas_context.failed');
      this.teardown();
      return;
    }

    const overlay = document.createElement('div');
    overlay.setAttribute(DVR_OVERLAY_ATTR, 'video-dvr-player');
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

    // Native controls are part of the video element: hiding the whole element
    // also hides its play/seek/volume/fullscreen UI. For controlled videos the
    // opaque DVR canvases cover the picture while the native chrome stays live.
    if (!video.controls) {
      this.originalOpacity = video.style.opacity;
      video.style.setProperty('opacity', '0', 'important');
      this.hidNativeVideo = true;
    }
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

    if (!overlayHomed(video, surfaces.overlay, context)) {
      ensurePositionContext(context.box);
      homeOverlay(video, surfaces.overlay, context);
    }

    const videoRect = video.getBoundingClientRect();
    const boxRect = context.box.getBoundingClientRect();
    const placement = overlayPlacement(video, context.box, videoRect, boxRect);
    if (placement.top !== this.lastOffset.top || placement.left !== this.lastOffset.left) {
      this.lastOffset = { top: placement.top, left: placement.left };
      surfaces.overlay.style.position = placement.position;
      surfaces.overlay.style.top = `${placement.top}px`;
      surfaces.overlay.style.left = `${placement.left}px`;
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
    const { video, store, timeline, getDelaySec, getMasking } = this.opts;
    const { surfaces } = this;
    if (!surfaces) return;
    const { width, height } = this.lastSize;
    if (width <= 0 || height <= 0) return;

    const delaySec = getDelaySec();
    // A replay fires 'play' before its rewinding 'seeked' reaches the machine:
    // the moment the media clock runs again, the drain is over.
    if (this.drainClock && !video.ended) this.drainClock = null;
    // Clamped to the earliest buffered frame: while the buffer is still
    // shorter than D (warm-up, post-seek re-warm, loop restart), playback
    // holds on that frame — masked — until now − D reaches it, then runs.
    const oldest = store.oldestTime();
    const newest = store.newestTime();
    const nowSec = performance.now() / 1000;
    const wallDt = this.lastTickWallSec === null ? 0 : nowSec - this.lastTickWallSec;
    this.lastTickWallSec = nowSec;
    const idealTarget =
      this.drainClock && newest !== null
        ? drainTargetTime(this.drainClock, nowSec, newest)
        : clampToOldest(video.currentTime - delaySec, oldest);
    let targetTime = idealTarget;
    if (this.hasPresentedFrame && !this.drainClock && this.presentedClockSec !== null) {
      const maxAdvance = video.paused ? 0 : wallDt * video.playbackRate * PRESENTED_CATCH_UP_RATE;
      targetTime = Math.min(idealTarget, clampToOldest(this.presentedClockSec + maxAdvance, oldest));
    }
    this.presentedClockSec = targetTime;
    const frame = store.frameAt(targetTime);
    if (!frame && this.hasPresentedFrame) return;
    const masking = getMasking();
    // When inference cannot keep up, stretch verdicts (inertia) further rather
    // than blurring: the bridge horizon scales with the observed round-trip.
    const bridgeHorizonSec = Math.max(BRIDGE_HORIZON_SEC, delaySec * 2);
    const verdict = timeline.verdictFor(frame ? frame.mediaTime : video.currentTime, bridgeHorizonSec);

    // A verdict-less frame always fails closed: a Thumbnail-cleared session
    // must not fail-open playback frames its poster verdict does not describe
    // (that showed Shorts' unsafe first frame unmasked for a round-trip). The
    // buffered frame draws whole-blurred so the verdict unblurs it in place;
    // the live element is the fallback only when nothing is buffered yet,
    // keyed at the capture cadence. Everything else redraws only when the
    // frame, verdict, or size moved (position never forces a redraw).
    const content = computeRenderedContentRect(video, this.lastSize);
    // Device-pixel backing stores, CSS-pixel draw coordinates: without the dpr
    // scale a HiDPI display presents at CSS resolution and every frame looks
    // soft no matter how large the capture is. But a backing store finer than
    // the buffered frame only spends fill rate upscaling pixels the ring never
    // captured — which is exactly what fullscreen does (the layout grows, the
    // ring frame does not), so cap the ratio at the source's own resolution.
    const dpr = frameCappedDpr(frame, content.width);
    const drawKey = [
      frame ? frame.mediaTime : `live:${Math.floor(video.currentTime * NONE_REDRAWS_PER_SEC)}`,
      verdict.kind,
      // Verdict identity, not just count: while pinned on the warm-up
      // frame, a newer verdict must refresh the mask geometry.
      verdict.kind === 'unsafe' ? verdict.entries.map(entry => entry.timestampSec).join(',') : '',
      width,
      height,
      dpr,
      masking.pixelationScale,
    ].join('|');
    if (drawKey === this.lastDrawKey) return;
    this.lastDrawKey = drawKey;

    const { baseCanvas, baseCtx, maskCanvas, maskCtx } = surfaces;
    resizeCanvas(baseCanvas, width, height, dpr);
    resizeCanvas(maskCanvas, width, height, dpr);
    baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

    if (!frame) {
      // Drawing a cross-origin video only taints the canvas — display still works.
      const liveFrame: PresentableFrame = {
        source: video,
        width: video.videoWidth,
        height: video.videoHeight,
        mediaTime: video.currentTime,
      };
      maskCanvas.style.filter = '';
      baseCtx.drawImage(video, content.offsetX, content.offsetY, content.width, content.height);
      if (verdict.kind === 'unsafe' && liveFrame.width > 0) {
        baseCanvas.style.filter = '';
        this.renderMasks(liveFrame, verdict.entries, content, masking);
      } else {
        baseCanvas.style.filter = verdict.kind === 'clean' ? '' : buildMaskingFilter(masking);
      }
      return;
    }

    this.hasPresentedFrame = true;
    if (frame.mediaTime !== this.lastPresentedMediaTime) {
      this.lastPresentedMediaTime = frame.mediaTime;
      this.presentedFrameCount++;
      surfaces.overlay.dataset.hbPresentedFrames = String(this.presentedFrameCount);
    }
    if (verdict.kind === 'none') {
      // Verdict pending (warm-up pin, coverage hole): buffered frame,
      // whole-blurred, so the arriving verdict unblurs it in place.
      maskCanvas.style.filter = '';
      baseCtx.drawImage(
        frame.source,
        0,
        0,
        frame.width,
        frame.height,
        content.offsetX,
        content.offsetY,
        content.width,
        content.height,
      );
      baseCanvas.style.filter = buildMaskingFilter(masking);
      return;
    }
    baseCanvas.style.filter = '';
    baseCtx.drawImage(
      frame.source,
      0,
      0,
      frame.width,
      frame.height,
      content.offsetX,
      content.offsetY,
      content.width,
      content.height,
    );

    if (verdict.kind === 'unsafe') {
      this.renderMasks(frame, verdict.entries, content, masking);
    } else {
      maskCanvas.style.filter = '';
    }
  }

  /**
   * Same technique as the GIF player: pixelate the frame into the content
   * rect, then destination-in with the union of all in-window mask grids.
   */
  private renderMasks(
    frame: PresentableFrame,
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
    const tmp = this.pixelateScratch;
    if (tmp.width !== smallW) tmp.width = smallW;
    if (tmp.height !== smallH) tmp.height = smallH;
    const tmpCtx = tmp.getContext('2d');
    if (!tmpCtx) return;
    tmpCtx.clearRect(0, 0, smallW, smallH);
    tmpCtx.imageSmoothingEnabled = true;
    tmpCtx.drawImage(frame.source, 0, 0, frame.width, frame.height, 0, 0, smallW, smallH);

    maskCtx.imageSmoothingEnabled = false;
    maskCtx.drawImage(tmp, content.offsetX, content.offsetY, content.width, content.height);

    // The union stencil lives in CSS coordinates: maskCtx carries the dpr
    // transform, so drawImage(union, 0, 0) at natural size spans the canvas.
    // Mask grids are far coarser than CSS resolution, so the stencil needs no
    // device-pixel backing of its own.
    const union = this.unionScratch;
    const unionWidth = Math.max(1, Math.round(this.lastSize.width));
    const unionHeight = Math.max(1, Math.round(this.lastSize.height));
    if (union.width !== unionWidth) union.width = unionWidth;
    if (union.height !== unionHeight) union.height = unionHeight;
    const unionCtx = union.getContext('2d');
    if (!unionCtx) return;
    unionCtx.clearRect(0, 0, union.width, union.height);
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

/** A presented position can never reach behind the ring's earliest buffered frame. */
function clampToOldest(mediaTime: number, oldest: number | null): number {
  return oldest === null ? mediaTime : Math.max(mediaTime, oldest);
}

/**
 * Device-pixel ratio to back the presentation canvases with, capped so the
 * backing store never exceeds the buffered frame's own resolution: past that
 * point every extra device pixel is interpolation, paid for at fullscreen fill
 * rates. Never below 1 (a CSS-pixel store stays the floor), and the live
 * fallback keeps the true ratio — its source is the native element.
 */
function frameCappedDpr(frame: PresentableFrame | null, contentWidth: number): number {
  const dpr = globalThis.devicePixelRatio || 1;
  if (!frame || contentWidth <= 0) return dpr;
  return Math.min(dpr, Math.max(1, frame.width / contentWidth));
}

/** Backing store in device pixels, CSS size in layout pixels. */
function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): void {
  const canvasWidth = Math.max(1, Math.round(width * dpr));
  const canvasHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
  if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
  const cssWidth = `${width}px`;
  const cssHeight = `${height}px`;
  if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
  if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
}

function restoreOpacity(video: HTMLVideoElement, originalOpacity: string | undefined): void {
  if (originalOpacity) {
    video.style.opacity = originalOpacity;
  } else {
    video.style.removeProperty('opacity');
  }
}
