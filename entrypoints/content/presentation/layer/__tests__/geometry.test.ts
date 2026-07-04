import { describe, expect, it } from 'vitest';

import {
  clipsEqual,
  computeClipInsets,
  hasArea,
  intersectRects,
  isUnclipped,
  rectsEqual,
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
