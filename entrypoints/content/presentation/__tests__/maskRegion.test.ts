import { describe, expect, it } from 'vitest';

import {
  cellBoundsToContentRect,
  maskCellBounds,
  padAndClampRect,
  rectCovers,
  toDevicePixels,
  unionRects,
} from '@/entrypoints/content/presentation/maskRegion';

const grid = (rows: string[]) => rows.map(row => [...row].map(cell => (cell === '#' ? 1 : 0)));

describe('maskCellBounds', () => {
  it('returns the exclusive bounding box of every set cell across grids', () => {
    const a = grid(['....', '.#..', '....', '....']);
    const b = grid(['....', '....', '..##', '....']);
    expect(maskCellBounds([a, b])).toEqual({ x0: 1, y0: 1, x1: 4, y1: 3 });
  });

  it('is null when no cell is set', () => {
    expect(maskCellBounds([grid(['..', '..'])])).toBeNull();
  });
});

describe('cellBoundsToContentRect', () => {
  it('maps grid cells through the mask source rect onto the content rect', () => {
    const rect = cellBoundsToContentRect(
      { x0: 2, y0: 1, x1: 4, y1: 3 },
      { srcX: 0, srcY: 0, srcW: 8, srcH: 4 },
      { offsetX: 100, offsetY: 50, width: 800, height: 400 },
    );
    expect(rect).toEqual({ x: 300, y: 150, width: 200, height: 200 });
  });
});

describe('padAndClampRect', () => {
  it('pads by the block size and clamps to the content rect on whole pixels', () => {
    const rect = padAndClampRect({ x: 10.4, y: 0, width: 20, height: 20 }, 8, {
      offsetX: 0,
      offsetY: 0,
      width: 640,
      height: 360,
    });
    expect(rect).toEqual({ x: 2, y: 0, width: 37, height: 28 });
  });

  it('is null when the padded rect falls outside the content', () => {
    expect(
      padAndClampRect({ x: -50, y: -50, width: 10, height: 10 }, 2, {
        offsetX: 0,
        offsetY: 0,
        width: 640,
        height: 360,
      }),
    ).toBeNull();
  });
});

describe('unionRects / rectCovers', () => {
  it('unions two rects and accepts a null seed', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 5, y: 5, width: 10, height: 20 };
    expect(unionRects(null, a)).toBe(a);
    expect(unionRects(a, b)).toEqual({ x: 0, y: 0, width: 15, height: 25 });
  });

  it('reports whether the content rect covers the whole canvas', () => {
    expect(rectCovers({ offsetX: 0, offsetY: 0, width: 640, height: 360 }, 640, 360)).toBe(true);
    expect(rectCovers({ offsetX: 0, offsetY: 40, width: 640, height: 280 }, 640, 360)).toBe(false);
  });
});

describe('toDevicePixels', () => {
  it('snaps a CSS rect to whole device pixels without drifting its far edge', () => {
    const device = toDevicePixels({ offsetX: 0.3, offsetY: 10.7, width: 864.5, height: 486.2 }, 2.22);
    expect(device).toEqual({ offsetX: 1, offsetY: 24, width: 1919, height: 1079 });
    expect(device.offsetX + device.width).toBe(Math.round((0.3 + 864.5) * 2.22));
  });

  it('is the identity at dpr 1 on whole pixels', () => {
    const rect = { offsetX: 0, offsetY: 40, width: 640, height: 280 };
    expect(toDevicePixels(rect, 1)).toEqual(rect);
  });
});
