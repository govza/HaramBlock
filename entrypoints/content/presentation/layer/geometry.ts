import type { IClipInsets, ILayerRect } from '@/utils/types/presentation';

/**
 * Pure viewport-geometry helpers for the overlay layer. No DOM access — everything
 * operates on plain rect shapes so it stays unit-testable.
 */

/** Sub-pixel jitter below this is treated as "didn't move" to avoid redraw churn. */
export const RECT_EPSILON = 0.5;

export const hasArea = (rect: ILayerRect): boolean => rect.width > 0 && rect.height > 0;

export const rectsEqual = (a: ILayerRect | undefined, b: ILayerRect, epsilon = RECT_EPSILON): boolean =>
  a !== undefined &&
  Math.abs(a.top - b.top) < epsilon &&
  Math.abs(a.left - b.left) < epsilon &&
  Math.abs(a.width - b.width) < epsilon &&
  Math.abs(a.height - b.height) < epsilon;

/** Intersection of two viewport-space rects; null when they don't overlap. */
export const intersectRects = (a: ILayerRect, b: ILayerRect): ILayerRect | null => {
  const top = Math.max(a.top, b.top);
  const left = Math.max(a.left, b.left);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  const right = Math.min(a.left + a.width, b.left + b.width);
  if (right <= left || bottom <= top) return null;
  return { top, left, width: right - left, height: bottom - top };
};

/**
 * Insets that clip an element box down to the intersection of every clipping-ancestor
 * rect (`clip-path: inset(...)` semantics, relative to the element box).
 *
 * Returns null when the element is fully clipped out (nothing visible).
 */
export const computeClipInsets = (element: ILayerRect, clips: ILayerRect[]): IClipInsets | null => {
  let visible: ILayerRect | null = element;
  for (const clip of clips) {
    visible = intersectRects(visible, clip);
    if (!visible) return null;
  }
  return {
    top: visible.top - element.top,
    left: visible.left - element.left,
    right: element.left + element.width - (visible.left + visible.width),
    bottom: element.top + element.height - (visible.top + visible.height),
  };
};

export const isUnclipped = (insets: IClipInsets, epsilon = RECT_EPSILON): boolean =>
  insets.top < epsilon && insets.left < epsilon && insets.right < epsilon && insets.bottom < epsilon;

export const clipsEqual = (
  a: IClipInsets | null | undefined,
  b: IClipInsets | null,
  epsilon = RECT_EPSILON,
): boolean => {
  if (a === undefined) return false;
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.top - b.top) < epsilon &&
    Math.abs(a.left - b.left) < epsilon &&
    Math.abs(a.right - b.right) < epsilon &&
    Math.abs(a.bottom - b.bottom) < epsilon
  );
};
