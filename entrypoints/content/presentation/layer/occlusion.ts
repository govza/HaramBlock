import {
  cssColorAlpha,
  occlusionSamplePoints,
  OCCLUDER_MIN_ALPHA,
} from '@/entrypoints/content/presentation/layer/geometry';

import type { IClipInsets, ILayerRect } from '@/utils/types/presentation';

/**
 * Occlusion detection for the overlay layer: is a tracked element fully covered by
 * opaque site content (a lightbox backdrop, a modal panel)? If so, its mask slot is
 * hidden — otherwise masks float above UI the site intends to cover the element with.
 *
 * Every heuristic here fails toward "not occluded" (mask stays visible): transparent
 * overlays (stretched-link cards), unparseable styles, and un-hit-testable elements
 * never hide a mask.
 */

/** Elements that paint their own pixels regardless of background style. */
const OPAQUE_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'EMBED', 'OBJECT', 'SVG']);

/** Ancestor check that crosses shadow boundaries via the host chain. */
const shadowInclusiveContains = (ancestor: Element, node: Element): boolean => {
  for (let current: Element | null = node; current; ) {
    if (current === ancestor) return true;
    if (current.parentElement) {
      current = current.parentElement;
    } else {
      const root = current.getRootNode();
      current = root instanceof ShadowRoot ? root.host : null;
    }
  }
  return false;
};

const parentOf = (element: Element): Element | null => {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
};

/** Does this element paint opaque-enough pixels to visually cover what's beneath it? */
const rendersOpaquePixels = (element: Element): boolean => {
  if (OPAQUE_TAGS.has(element.tagName.toUpperCase())) return true;
  const style = getComputedStyle(element);
  if (cssColorAlpha(style.backgroundColor) >= OCCLUDER_MIN_ALPHA) return true;
  if (style.backgroundImage !== 'none') return true;
  // A backdrop-filter (blur/darken) obscures content even with a transparent background
  if (style.backdropFilter && style.backdropFilter !== 'none') return true;
  return false;
};

/**
 * Whether `occluder` — or one of its ancestors that is NOT also an ancestor of
 * `element` — paints opaque pixels. The ancestor walk covers lightboxes whose deepest
 * hit-test target is a transparent centering container inside an opaque wrapper.
 */
const isOpaqueOccluder = (occluder: Element, element: Element): boolean => {
  for (let node: Element | null = occluder; node && !shadowInclusiveContains(node, element); node = parentOf(node)) {
    if (rendersOpaquePixels(node)) return true;
  }
  return false;
};

/**
 * True when every visible sample point of the element is covered by opaque foreign
 * content. Uses hit testing, so elements that opt out of it (pointer-events: none)
 * are never reported occluded.
 */
export const isElementOccluded = (
  element: Element,
  rect: ILayerRect,
  clip: IClipInsets | null,
  ignoreOccluder?: (candidate: Element) => boolean,
): boolean => {
  if (getComputedStyle(element).pointerEvents === 'none') return false;

  const points = occlusionSamplePoints(rect, clip);
  if (!points.length) return false;

  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  let sampled = false;

  for (const { x, y } of points) {
    if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || ignoreOccluder?.(hit)) continue; // our own layer UI decides nothing
    sampled = true;
    // The element (or its subtree/ancestors) is on top here — visibly not occluded.
    if (hit === element || shadowInclusiveContains(element, hit) || shadowInclusiveContains(hit, element)) {
      return false;
    }
    if (!isOpaqueOccluder(hit, element)) return false;
  }

  return sampled;
};
