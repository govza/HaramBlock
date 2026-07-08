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

// ---------------------------------------------------------------------------
// Stacking (slot z-index) helpers
// ---------------------------------------------------------------------------

export const MAX_Z_INDEX = 2147483647;

/** Numeric value of a computed `z-index`, or null for `auto`/unparseable values. */
export const parseZIndex = (value: string): number | null => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

/** The computed-style subset the stacking-context predicate reads (unit-testable). */
export interface IStackingStyle {
  position: string;
  zIndex: string;
  transform: string;
  filter: string;
  opacity: string;
  isolation: string;
  mixBlendMode: string;
  perspective: string;
  backdropFilter?: string;
}

const isSetTo = (value: string | undefined, other: string): boolean => Boolean(value) && value !== other;

/**
 * True when the computed style GUARANTEES the element creates a stacking context.
 * Deliberately incomplete: a missed trigger (`will-change`, `contain`, plain
 * `position: sticky`, future CSS) only makes chainMaxZ overestimate — safe. A false
 * positive here would discard a real z-index below the node and could put a mask
 * UNDER its own element, so every listed trigger must be spec-certain.
 */
export const createsStackingContext = (style: IStackingStyle): boolean =>
  isSetTo(style.transform, 'none') ||
  isSetTo(style.filter, 'none') ||
  isSetTo(style.backdropFilter, 'none') ||
  isSetTo(style.perspective, 'none') ||
  isSetTo(style.mixBlendMode, 'normal') ||
  style.isolation === 'isolate' ||
  (style.opacity !== '' && Number(style.opacity) < 1) ||
  (isSetTo(style.position, 'static') && parseZIndex(style.zIndex) !== null);

/**
 * Host z-index that paints above every tracked element: one above the highest
 * numeric z-index found on any tracked element's ancestor chain (`maxChain`).
 * Non-finite input (a failed chain walk) falls back to the maximum — fail-closed,
 * masks float above everything rather than risk sliding under their own image.
 */
export const nextSlotZ = (maxChain: number): number => {
  if (!Number.isFinite(maxChain)) return MAX_Z_INDEX;
  return Math.min(Math.max(1, maxChain + 1), MAX_Z_INDEX);
};

export interface ISlotCorrection {
  x: number;
  y: number;
}

/** Sub-pixel jitter below this is anchor rounding, not a pathology; don't churn styles. */
export const CORRECTION_EPSILON_PX = 0.5;

/**
 * Corrective translate for a slot whose anchor-positioned location strayed from its
 * element's rect (duplicate anchor names, engine bugs, transformed carousels — all
 * fail-open without this). The slot's ACTUAL rect already includes `current`, so the
 * new correction is `current + (target - actual)`. Returns null when the change is
 * within epsilon — the healthy path, where anchor positioning needs no help and no
 * style write happens at all.
 */
export const nextSlotCorrection = (
  target: { left: number; top: number },
  actual: { left: number; top: number },
  current: ISlotCorrection,
): ISlotCorrection | null => {
  const x = current.x + (target.left - actual.left);
  const y = current.y + (target.top - actual.top);
  if (Math.abs(x - current.x) < CORRECTION_EPSILON_PX && Math.abs(y - current.y) < CORRECTION_EPSILON_PX) return null;
  return { x, y };
};

/**
 * Merges per-entry caption-lift candidates into candidate -> the highest chainZ among
 * the tracked elements it overlaps — the base its lift z-index derives from (a
 * caption over two masked elements must clear BOTH their slots). Generic so the merge
 * is unit-testable without a DOM.
 */
export const mergeLiftCandidates = <T>(
  entries: Iterable<{ liftCandidates: readonly T[]; chainZ: number }>,
): Map<T, number> => {
  const all = new Map<T, number>();
  for (const { liftCandidates, chainZ } of entries) {
    for (const candidate of liftCandidates) {
      const known = all.get(candidate);
      if (known === undefined || chainZ > known) all.set(candidate, chainZ);
    }
  }
  return all;
};

// ---------------------------------------------------------------------------
// Hit-test sampling helpers
// ---------------------------------------------------------------------------

export interface IViewportPoint {
  x: number;
  y: number;
}

/**
 * Per-axis sample fractions: a 4x4 grid biased toward the edges (8% in), because the
 * content worth detecting often hugs an edge — caption bars, sticky corner chips. A
 * bottom bar covering >= 8% of the height is hit by the whole 0.92 row.
 */
const SAMPLE_FRACTIONS = [0.08, 0.35, 0.65, 0.92];

/**
 * Hit-test sample points spread over the visible (clip-reduced) part of an element
 * rect: an edge-biased 4x4 grid (16 points). Empty when nothing is visible. Used by
 * caption-lift candidate discovery.
 */
export const hitSamplePoints = (rect: ILayerRect, clip: IClipInsets | null): IViewportPoint[] => {
  if (clip === null) return [];
  const left = rect.left + clip.left;
  const top = rect.top + clip.top;
  const width = rect.width - clip.left - clip.right;
  const height = rect.height - clip.top - clip.bottom;
  if (width <= 0 || height <= 0) return [];

  const points: IViewportPoint[] = [];
  for (const fy of SAMPLE_FRACTIONS) {
    for (const fx of SAMPLE_FRACTIONS) {
      points.push({ x: left + width * fx, y: top + height * fy });
    }
  }
  return points;
};
