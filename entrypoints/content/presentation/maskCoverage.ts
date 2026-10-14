import { calculatePixelationBlockSize, buildCanvasTintFilter } from '@/utils/masking';
import { decodeMaskRLE } from '@/utils/rle';
import { getLogger } from '@/utils/telemetry';

import type { ContentRect } from '@/entrypoints/content/presentation/imageLayout';
import type { IElementPrediction, IMaskingSettings, IMaskTransform } from '@/utils/types';

const log = getLogger('maskCoverage');

const COVERED_CELL_THRESHOLD = 0.5;

/**
 * Rectangle of covered mask-grid cells merged across rows. Coordinates are cell indices,
 * end-exclusive.
 */
interface CellRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Sub-rectangle of the mask grid that holds real image pixels (letterbox padding excluded); it is
 * what gets stretched onto the rendered content rectangle.
 */
interface GridWindow {
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
}

/**
 * A covered region mapped onto the element box, as edges in CSS pixels. Edges rather than a size so
 * callers formatting each edge get the exact mapped value.
 */
export interface CoverageRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const imageWindowOf = (transform: IMaskTransform, originalWidth: number, originalHeight: number): GridWindow => ({
  srcX: transform.offsetX,
  srcY: transform.offsetY,
  srcW: originalWidth / transform.scaleX,
  srcH: originalHeight / transform.scaleY,
});

const hasMask = (prediction: IElementPrediction): boolean => Boolean(prediction.masks?.runs?.length);

const unionCoveredCells = (grids: number[][][], width: number, height: number): Uint8Array => {
  const covered = new Uint8Array(width * height);
  for (const grid of grids) {
    if (grid.length !== height || grid[0]?.length !== width) continue;
    grid.forEach((row, y) => {
      row.forEach((value, x) => {
        if (value > COVERED_CELL_THRESHOLD) covered[y * width + x] = 1;
      });
    });
  }
  return covered;
};

const rowRuns = (covered: Uint8Array, y: number, width: number): [number, number][] => {
  const runs: [number, number][] = [];
  let start = -1;
  for (let x = 0; x < width; x++) {
    const isCovered = covered[y * width + x] === 1;
    if (isCovered && start < 0) start = x;
    if (!isCovered && start >= 0) {
      runs.push([start, x]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, width]);
  return runs;
};

const mergeIntoCellRects = (covered: Uint8Array, width: number, height: number): CellRect[] => {
  const closed: CellRect[] = [];
  let open = new Map<string, CellRect>();
  for (let y = 0; y < height; y++) {
    const next = new Map<string, CellRect>();
    for (const [x0, x1] of rowRuns(covered, y, width)) {
      const key = `${x0}:${x1}`;
      const extended = open.get(key);
      if (extended) {
        extended.y1 = y + 1;
        open.delete(key);
        next.set(key, extended);
      } else {
        next.set(key, { x0, x1, y0: y, y1: y + 1 });
      }
    }
    closed.push(...open.values());
    open = next;
  }
  closed.push(...open.values());
  return closed.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
};

const createContext = (width: number, height: number, name: string): CanvasRenderingContext2D | null => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) log.error('overlay.canvas_context.failed', { canvas: name });
  return ctx;
};

/**
 * The union of a verdict's segmentation masks: which model-grid cells are covered, and how that grid
 * maps onto whatever content rectangle the media is rendered into.
 */
export class MaskCoverage {
  private constructor(
    private readonly gridWidth: number,
    private readonly gridHeight: number,
    private readonly cellRects: readonly CellRect[],
    private readonly imageWindow: GridWindow,
  ) {}

  /**
   * Decodes and unions the masks sharing the first mask's grid size. Null when no prediction
   * carries a usable mask.
   */
  static from(
    predictions: readonly IElementPrediction[],
    transform: IMaskTransform,
    originalWidth: number,
    originalHeight: number,
  ): MaskCoverage | null {
    const grids = predictions.filter(hasMask).map(prediction => decodeMaskRLE(prediction.masks));
    const first = grids.find(grid => grid.length);
    const gridHeight = first?.length ?? 0;
    const gridWidth = first?.[0]?.length ?? 0;
    if (!gridWidth || !gridHeight) return null;

    const covered = unionCoveredCells(grids, gridWidth, gridHeight);
    return new MaskCoverage(
      gridWidth,
      gridHeight,
      mergeIntoCellRects(covered, gridWidth, gridHeight),
      imageWindowOf(transform, originalWidth, originalHeight),
    );
  }

  rects(content: ContentRect): CoverageRect[] {
    const { srcX, srcY, srcW, srcH } = this.imageWindow;
    const toX = (gridX: number) => content.offsetX + ((gridX - srcX) * content.width) / srcW;
    const toY = (gridY: number) => content.offsetY + ((gridY - srcY) * content.height) / srcH;
    return this.cellRects.map(rect => ({
      left: toX(rect.x0),
      top: toY(rect.y0),
      right: toX(rect.x1),
      bottom: toY(rect.y1),
    }));
  }

  /** Paints covered cells as opaque alpha, scaled with nearest-neighbour onto the content rectangle. */
  paintAlpha(ctx: CanvasRenderingContext2D, content: ContentRect): void {
    const gridCtx = createContext(this.gridWidth, this.gridHeight, 'grid');
    if (!gridCtx) return;
    gridCtx.fillStyle = 'rgba(0,0,0,1)';
    for (const rect of this.cellRects) {
      gridCtx.fillRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
    }

    const { srcX, srcY, srcW, srcH } = this.imageWindow;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      gridCtx.canvas,
      srcX,
      srcY,
      srcW,
      srcH,
      content.offsetX,
      content.offsetY,
      content.width,
      content.height,
    );
  }
}

/**
 * Replaces the canvas with a pixelated copy of `source` drawn into the content rectangle, kept only
 * where the coverage is, and tinted via CSS filter.
 */
export const paintPixelatedMask = (
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  coverage: MaskCoverage,
  content: ContentRect,
  masking: IMaskingSettings,
): void => {
  if (content.width <= 0 || content.height <= 0) return;
  const { canvas } = ctx;

  const blockSize = calculatePixelationBlockSize(masking.pixelationScale);
  const downscaledCtx = createContext(
    Math.max(1, Math.floor(content.width / blockSize)),
    Math.max(1, Math.floor(content.height / blockSize)),
    'tmp',
  );
  if (!downscaledCtx) return;
  const downscaled = downscaledCtx.canvas;
  downscaledCtx.imageSmoothingEnabled = true;
  downscaledCtx.drawImage(source, 0, 0, downscaled.width, downscaled.height);

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(downscaled, content.offsetX, content.offsetY, content.width, content.height);

  const alphaCtx = createContext(canvas.width, canvas.height, 'mask');
  if (!alphaCtx) return;
  coverage.paintAlpha(alphaCtx, content);

  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(alphaCtx.canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  canvas.style.filter = buildCanvasTintFilter(masking);
};
