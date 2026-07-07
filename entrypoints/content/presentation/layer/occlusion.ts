import { qualifiesForLift, mayQualifyForLift } from '@/entrypoints/content/presentation/layer/captionLift';
import { parentOf, shadowInclusiveContains } from '@/entrypoints/content/presentation/layer/domWalk';
import {
  cssColorAlpha,
  occlusionSamplePoints,
  OCCLUDER_MIN_ALPHA,
} from '@/entrypoints/content/presentation/layer/geometry';

import type { IClipInsets, ILayerRect } from '@/utils/types/presentation';

/**
 * Occlusion scan for the overlay layer, one hit-test pass answering two questions:
 *
 * 1. Is the tracked element FULLY covered by opaque site content (a lightbox
 *    backdrop, a modal panel)? If so, its mask slot is hidden — otherwise masks float
 *    above UI the site intends to cover the element with.
 * 2. Which site elements paint over PARTS of the element (caption bars, scrims) and
 *    qualify for a caption lift (see captionLift.ts)?
 *
 * Every heuristic here fails toward "keep the element masked": transparent overlays
 * (stretched-link cards), unparseable styles, and un-hit-testable elements never hide
 * a mask, and a candidate that fails any lift qualification simply stays covered.
 */

/** Elements that paint their own pixels regardless of background style. */
const OPAQUE_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'EMBED', 'OBJECT', 'SVG']);

/** More simultaneous occluders than this is not a captions situation; lift nothing. */
const MAX_LIFT_CANDIDATES = 4;

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

export interface IOcclusionScan {
  /** True when every visible sample point is covered by opaque foreign content. */
  occluded: boolean;
  /**
   * Foreign elements painting above the tracked element that fully qualify for a
   * caption lift. Empty when occluded (the slot hides anyway) or when detection
   * bails (fail-closed: captions stay covered).
   */
  liftCandidates: HTMLElement[];
}

const NO_SCAN: IOcclusionScan = { occluded: false, liftCandidates: [] };

/**
 * Walks from a hit up to the first shared ancestor with `element`, answering both
 * "is this hit chain opaque?" (for full occlusion, 0.45-alpha class of checks) and
 * "which node should a caption lift target?" — the OUTERMOST chain node where a
 * z-index would apply (the whole caption bar, not a text span inside it).
 */
const analyzeHitChain = (hit: Element, element: Element): { opaque: boolean; liftCandidate: HTMLElement | null } => {
  let opaque = false;
  let liftCandidate: HTMLElement | null = null;
  for (let node: Element | null = hit; node && !shadowInclusiveContains(node, element); node = parentOf(node)) {
    if (!opaque && rendersOpaquePixels(node)) opaque = true;
    if (node instanceof HTMLElement && mayQualifyForLift(node)) liftCandidate = node;
  }
  return { opaque, liftCandidate };
};

/**
 * Hit-tests the element's visible sample points. Uses hit testing, so elements that
 * opt out of it (pointer-events: none) are never reported occluded and captions that
 * opt out are never lifted.
 */
export const scanOcclusion = (
  element: Element,
  rect: ILayerRect,
  clip: IClipInsets | null,
  ignoreOccluder?: (candidate: Element) => boolean,
): IOcclusionScan => {
  if (getComputedStyle(element).pointerEvents === 'none') return NO_SCAN;

  const points = occlusionSamplePoints(rect, clip);
  if (!points.length) return NO_SCAN;

  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  let sampled = false;
  let allOpaque = true;
  const candidates = new Set<HTMLElement>();

  for (const { x, y } of points) {
    if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || ignoreOccluder?.(hit)) continue; // our own layer UI decides nothing
    sampled = true;
    // The element (or its subtree/ancestors) is on top here — visibly not occluded.
    if (hit === element || shadowInclusiveContains(element, hit) || shadowInclusiveContains(hit, element)) {
      allOpaque = false;
      continue;
    }
    const { opaque, liftCandidate } = analyzeHitChain(hit, element);
    if (!opaque) allOpaque = false;
    if (liftCandidate) candidates.add(liftCandidate);
  }

  const occluded = sampled && allOpaque;
  if (occluded || candidates.size > MAX_LIFT_CANDIDATES) return { occluded, liftCandidates: [] };

  // Full qualification (subtree media scan, stacking-context chain) once per distinct
  // candidate, only on this throttled path.
  return { occluded, liftCandidates: [...candidates].filter(qualifiesForLift) };
};
