import { describe, expect, it } from 'vitest';

import {
  clipsEqual,
  computeClipInsets,
  createsStackingContext,
  cssColorAlpha,
  hasArea,
  intersectRects,
  isUnclipped,
  nextHostZ,
  occlusionSamplePoints,
  parseZIndex,
  rectsEqual,
  MAX_Z_INDEX,
  type IStackingStyle,
} from '@/entrypoints/content/presentation/layer/geometry';

import type { ILayerRect } from '@/utils/types/presentation';

const rect = (top: number, left: number, width: number, height: number): ILayerRect => ({
  top,
  left,
  width,
  height,
});

describe('rectsEqual', () => {
  it('treats sub-epsilon jitter as equal', () => {
    expect(rectsEqual(rect(10, 10, 100, 50), rect(10.4, 10.2, 100.1, 49.9))).toBe(true);
  });

  it('detects moves and resizes', () => {
    expect(rectsEqual(rect(10, 10, 100, 50), rect(11, 10, 100, 50))).toBe(false);
    expect(rectsEqual(rect(10, 10, 100, 50), rect(10, 10, 101, 50))).toBe(false);
  });

  it('is false when there is no previous rect', () => {
    expect(rectsEqual(undefined, rect(0, 0, 1, 1))).toBe(false);
  });
});

describe('hasArea', () => {
  it('requires both dimensions to be positive', () => {
    expect(hasArea(rect(0, 0, 10, 10))).toBe(true);
    expect(hasArea(rect(0, 0, 0, 10))).toBe(false);
    expect(hasArea(rect(0, 0, 10, 0))).toBe(false);
  });
});

describe('intersectRects', () => {
  it('returns the overlapping region', () => {
    expect(intersectRects(rect(0, 0, 100, 100), rect(50, 50, 100, 100))).toEqual(rect(50, 50, 50, 50));
  });

  it('returns null for disjoint rects', () => {
    expect(intersectRects(rect(0, 0, 10, 10), rect(20, 20, 10, 10))).toBeNull();
    // Touching edges do not count as overlap
    expect(intersectRects(rect(0, 0, 10, 10), rect(0, 10, 10, 10))).toBeNull();
  });

  it('returns the inner rect when fully contained', () => {
    expect(intersectRects(rect(0, 0, 100, 100), rect(10, 10, 20, 20))).toEqual(rect(10, 10, 20, 20));
  });
});

describe('computeClipInsets', () => {
  it('returns zero insets when nothing clips', () => {
    const insets = computeClipInsets(rect(10, 10, 100, 100), []);
    expect(insets).toEqual({ top: 0, left: 0, right: 0, bottom: 0 });
    expect(insets && isUnclipped(insets)).toBe(true);
  });

  it('returns zero insets when the container fully contains the element', () => {
    const insets = computeClipInsets(rect(10, 10, 50, 50), [rect(0, 0, 200, 200)]);
    expect(insets).toEqual({ top: 0, left: 0, right: 0, bottom: 0 });
  });

  it('computes insets for an element scrolled half out of a container', () => {
    // Container viewport rows 0..100; element sticks out above (top: -40).
    const insets = computeClipInsets(rect(-40, 0, 100, 100), [rect(0, 0, 100, 100)]);
    expect(insets).toEqual({ top: 40, left: 0, right: 0, bottom: 0 });
    expect(insets && isUnclipped(insets)).toBe(false);
  });

  it('accumulates insets across nested containers', () => {
    const insets = computeClipInsets(rect(0, 0, 100, 100), [
      rect(10, 0, 200, 200), // clips 10 off the top
      rect(0, 20, 200, 200), // clips 20 off the left
    ]);
    expect(insets).toEqual({ top: 10, left: 20, right: 0, bottom: 0 });
  });

  it('returns null when the element is fully clipped out', () => {
    expect(computeClipInsets(rect(0, 0, 100, 100), [rect(500, 500, 10, 10)])).toBeNull();
  });

  it('returns null when nested containers have no common visible region', () => {
    expect(
      computeClipInsets(rect(0, 0, 100, 100), [
        rect(0, 0, 100, 40), // bottom clipped: visible rows 0..40
        rect(0, 60, 100, 100), // left clipped past the visible band
      ]),
    ).toEqual({ top: 0, left: 60, right: 0, bottom: 60 });
    expect(
      computeClipInsets(rect(0, 0, 100, 100), [
        rect(0, 0, 100, 40), // visible rows 0..40
        rect(50, 0, 100, 100), // visible rows 50..100 — disjoint
      ]),
    ).toBeNull();
  });
});

describe('clipsEqual', () => {
  it('compares null states', () => {
    expect(clipsEqual(null, null)).toBe(true);
    expect(clipsEqual(null, { top: 0, left: 0, right: 0, bottom: 0 })).toBe(false);
    expect(clipsEqual(undefined, null)).toBe(false);
  });

  it('compares insets with epsilon', () => {
    expect(clipsEqual({ top: 10, left: 0, right: 0, bottom: 0 }, { top: 10.3, left: 0, right: 0, bottom: 0 })).toBe(
      true,
    );
    expect(clipsEqual({ top: 10, left: 0, right: 0, bottom: 0 }, { top: 12, left: 0, right: 0, bottom: 0 })).toBe(
      false,
    );
  });
});

describe('occlusionSamplePoints', () => {
  it('spreads five points over an unclipped rect', () => {
    const points = occlusionSamplePoints(rect(0, 0, 100, 100), { top: 0, left: 0, right: 0, bottom: 0 });
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual({ x: 50, y: 50 }); // center
    expect(points[1]).toEqual({ x: 20, y: 20 });
    expect(points[4]).toEqual({ x: 80, y: 80 });
  });

  it('samples only the visible (clip-reduced) region', () => {
    const points = occlusionSamplePoints(rect(0, 0, 100, 100), { top: 50, left: 0, right: 0, bottom: 0 });
    // Visible band is rows 50..100; every sample must be inside it
    for (const p of points) {
      expect(p.y).toBeGreaterThanOrEqual(50);
      expect(p.y).toBeLessThanOrEqual(100);
    }
  });

  it('returns nothing for fully clipped or degenerate rects', () => {
    expect(occlusionSamplePoints(rect(0, 0, 100, 100), null)).toEqual([]);
    expect(occlusionSamplePoints(rect(0, 0, 100, 100), { top: 60, left: 0, right: 0, bottom: 60 })).toEqual([]);
    expect(occlusionSamplePoints(rect(0, 0, 0, 100), { top: 0, left: 0, right: 0, bottom: 0 })).toEqual([]);
  });
});

describe('parseZIndex', () => {
  it('parses numeric computed values', () => {
    expect(parseZIndex('0')).toBe(0);
    expect(parseZIndex('100')).toBe(100);
    expect(parseZIndex('-5')).toBe(-5);
    expect(parseZIndex('2147483647')).toBe(2147483647);
  });

  it('returns null for auto and garbage', () => {
    expect(parseZIndex('auto')).toBeNull();
    expect(parseZIndex('')).toBeNull();
    expect(parseZIndex('inherit')).toBeNull();
  });
});

describe('createsStackingContext', () => {
  const plain: IStackingStyle = {
    position: 'static',
    zIndex: 'auto',
    transform: 'none',
    filter: 'none',
    opacity: '1',
    isolation: 'auto',
    mixBlendMode: 'normal',
    perspective: 'none',
    backdropFilter: 'none',
  };

  it('is false for a plain block', () => {
    expect(createsStackingContext(plain)).toBe(false);
  });

  it('fires on spec-certain triggers', () => {
    expect(createsStackingContext({ ...plain, transform: 'matrix(1, 0, 0, 1, 0, 0)' })).toBe(true);
    expect(createsStackingContext({ ...plain, filter: 'blur(2px)' })).toBe(true);
    expect(createsStackingContext({ ...plain, backdropFilter: 'blur(2px)' })).toBe(true);
    expect(createsStackingContext({ ...plain, perspective: '500px' })).toBe(true);
    expect(createsStackingContext({ ...plain, mixBlendMode: 'multiply' })).toBe(true);
    expect(createsStackingContext({ ...plain, isolation: 'isolate' })).toBe(true);
    expect(createsStackingContext({ ...plain, opacity: '0.99' })).toBe(true);
    expect(createsStackingContext({ ...plain, position: 'relative', zIndex: '0' })).toBe(true);
    expect(createsStackingContext({ ...plain, position: 'sticky', zIndex: '5' })).toBe(true);
  });

  it('stays false for non-guaranteed cases (missing a trigger only overestimates)', () => {
    // Positioned with z-index auto does not create a context (sticky aside — not guaranteed here)
    expect(createsStackingContext({ ...plain, position: 'relative' })).toBe(false);
    // z-index on a static element does not apply
    expect(createsStackingContext({ ...plain, zIndex: '999' })).toBe(false);
    // Unresolved/empty computed values (defensive: must never fire)
    expect(
      createsStackingContext({
        position: '',
        zIndex: '',
        transform: '',
        filter: '',
        opacity: '',
        isolation: '',
        mixBlendMode: '',
        perspective: '',
        backdropFilter: undefined,
      }),
    ).toBe(false);
  });
});

describe('nextHostZ', () => {
  it('stays one above the highest tracked chain z-index, floored at 1', () => {
    expect(nextHostZ(0)).toBe(1);
    expect(nextHostZ(100)).toBe(101);
    expect(nextHostZ(5000)).toBe(5001);
  });

  it('clamps to the maximum and never overflows', () => {
    expect(nextHostZ(MAX_Z_INDEX)).toBe(MAX_Z_INDEX);
    expect(nextHostZ(MAX_Z_INDEX - 1)).toBe(MAX_Z_INDEX);
  });

  it('falls back to the maximum on non-finite input (fail-closed)', () => {
    expect(nextHostZ(Number.POSITIVE_INFINITY)).toBe(MAX_Z_INDEX);
    expect(nextHostZ(Number.NaN)).toBe(MAX_Z_INDEX);
  });
});

describe('cssColorAlpha', () => {
  it('parses computed rgb/rgba colors', () => {
    expect(cssColorAlpha('rgb(255, 255, 255)')).toBe(1);
    expect(cssColorAlpha('rgba(0, 0, 0, 0.5)')).toBe(0.5);
    expect(cssColorAlpha('rgba(0, 0, 0, 0)')).toBe(0);
    expect(cssColorAlpha('rgb(0 0 0 / 0.8)')).toBe(0.8);
  });

  it('treats transparent and unparseable values as not opaque (fail-safe)', () => {
    expect(cssColorAlpha('transparent')).toBe(0);
    expect(cssColorAlpha('')).toBe(0);
    expect(cssColorAlpha('color(srgb 1 0 0)')).toBe(0);
    expect(cssColorAlpha('rgba(0, 0, 0, garbage)')).toBe(0);
  });

  it('clamps out-of-range alpha', () => {
    expect(cssColorAlpha('rgba(0, 0, 0, 1.5)')).toBe(1);
    expect(cssColorAlpha('rgba(0, 0, 0, -1)')).toBe(0);
  });
});
