export interface CellBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ContentRect {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

export function maskCellBounds(masks: readonly (readonly number[])[][]): CellBounds | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const grid of masks) {
    for (let y = 0; y < grid.length; y++) {
      const row = grid[y];
      if (!row) continue;
      for (let x = 0; x < row.length; x++) {
        const value = row[x];
        if (typeof value !== 'number' || value <= 0.5) continue;
        if (x < x0) x0 = x;
        if (x + 1 > x1) x1 = x + 1;
        if (y < y0) y0 = y;
        if (y + 1 > y1) y1 = y + 1;
      }
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

export function cellBoundsToContentRect(
  bounds: CellBounds,
  src: { srcX: number; srcY: number; srcW: number; srcH: number },
  content: ContentRect,
): PixelRect {
  const scaleX = content.width / src.srcW;
  const scaleY = content.height / src.srcH;
  const left = content.offsetX + (bounds.x0 - src.srcX) * scaleX;
  const top = content.offsetY + (bounds.y0 - src.srcY) * scaleY;
  const right = content.offsetX + (bounds.x1 - src.srcX) * scaleX;
  const bottom = content.offsetY + (bounds.y1 - src.srcY) * scaleY;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function unionRects(a: PixelRect | null, b: PixelRect): PixelRect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function padAndClampRect(rect: PixelRect, pad: number, clampTo: ContentRect): PixelRect | null {
  const x = Math.max(clampTo.offsetX, Math.floor(rect.x - pad));
  const y = Math.max(clampTo.offsetY, Math.floor(rect.y - pad));
  const right = Math.min(clampTo.offsetX + clampTo.width, Math.ceil(rect.x + rect.width + pad));
  const bottom = Math.min(clampTo.offsetY + clampTo.height, Math.ceil(rect.y + rect.height + pad));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function rectCovers(rect: ContentRect, width: number, height: number): boolean {
  return (
    rect.offsetX <= 0 && rect.offsetY <= 0 && rect.offsetX + rect.width >= width && rect.offsetY + rect.height >= height
  );
}

export function toDevicePixels(rect: ContentRect, dpr: number): ContentRect {
  const offsetX = Math.round(rect.offsetX * dpr);
  const offsetY = Math.round(rect.offsetY * dpr);
  return {
    offsetX,
    offsetY,
    width: Math.round((rect.offsetX + rect.width) * dpr) - offsetX,
    height: Math.round((rect.offsetY + rect.height) * dpr) - offsetY,
  };
}
