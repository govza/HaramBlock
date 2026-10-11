import { maskGridSrcRect, type ContentRect } from '@/entrypoints/content/presentation/imageLayout';
import { decodeMaskRLE } from '@/utils/rle';

import type { VerdictEntry } from '@/entrypoints/content/video/timeline/verdictTimeline';

/**
 * Rectangle of unsafe mask-grid cells merged across rows, turned into one `clip-path` subpath.
 * Coordinates are cell indices, end-exclusive.
 */
interface CellRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const formatPx = (value: number): string => String(Math.round(value * 100) / 100);

function rowRuns(row: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  row.forEach((value, x) => {
    if (value > 0.5 && start < 0) start = x;
    if (value <= 0.5 && start >= 0) {
      runs.push([start, x]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, row.length]);
  return runs;
}

function gridRects(grid: readonly (readonly number[])[]): CellRect[] {
  const closed: CellRect[] = [];
  let open = new Map<string, CellRect>();
  grid.forEach((row, y) => {
    const next = new Map<string, CellRect>();
    for (const [x0, x1] of rowRuns(row)) {
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
  });
  closed.push(...open.values());
  return closed.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

export function maskClipPath(entries: readonly VerdictEntry[], content: ContentRect): string | null {
  const segments: string[] = [];
  for (const entry of entries) {
    const { srcX, srcY, srcW, srcH } = maskGridSrcRect(entry.maskTransform, entry.width, entry.height);
    const toX = (gridX: number) => content.offsetX + ((gridX - srcX) * content.width) / srcW;
    const toY = (gridY: number) => content.offsetY + ((gridY - srcY) * content.height) / srcH;
    for (const prediction of entry.predictions) {
      if (!prediction.masks || prediction.masks.runs.length === 0) continue;
      for (const rect of gridRects(decodeMaskRLE(prediction.masks))) {
        const left = formatPx(toX(rect.x0));
        segments.push(
          `M${left} ${formatPx(toY(rect.y0))}H${formatPx(toX(rect.x1))}V${formatPx(toY(rect.y1))}H${left}Z`,
        );
      }
    }
  }
  return segments.length > 0 ? segments.join('') : null;
}
