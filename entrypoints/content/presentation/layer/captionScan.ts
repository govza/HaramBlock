import { qualifiesForLift, mayQualifyForLift } from '@/entrypoints/content/presentation/layer/captionLift';
import { parentOf, shadowInclusiveContains } from '@/entrypoints/content/presentation/layer/domWalk';
import { hitSamplePoints } from '@/entrypoints/content/presentation/layer/geometry';

import type { IClipInsets, ILayerRect } from '@/utils/types/presentation';

/**
 * Hit-test scan discovering site elements that paint over parts of a tracked element
 * (caption bars, scrims, duration badges) and qualify for a caption lift (see
 * captionLift.ts). Fail-closed: anything unqualifiable simply stays covered by the
 * mask.
 */

/** More simultaneous overlappers than this is not a captions situation; lift nothing. */
const MAX_LIFT_CANDIDATES = 4;

/**
 * Walks from a hit up to the first shared ancestor with `element`, picking the
 * OUTERMOST chain node where a z-index would apply (the whole caption bar, not a
 * text span inside it).
 */
const liftCandidateOnChain = (hit: Element, element: Element): HTMLElement | null => {
  let candidate: HTMLElement | null = null;
  for (let node: Element | null = hit; node && !shadowInclusiveContains(node, element); node = parentOf(node)) {
    if (node instanceof HTMLElement && mayQualifyForLift(node)) candidate = node;
  }
  return candidate;
};

/**
 * Hit-tests the element's visible sample points for caption-lift candidates. Uses hit
 * testing, so captions that opt out of it (pointer-events: none) are never lifted.
 */
export const scanLiftCandidates = (
  element: Element,
  rect: ILayerRect,
  clip: IClipInsets | null,
  ignoreHit?: (candidate: Element) => boolean,
): HTMLElement[] => {
  if (getComputedStyle(element).pointerEvents === 'none') return [];

  const points = hitSamplePoints(rect, clip);
  if (points.length === 0) return [];

  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const candidates = new Set<HTMLElement>();

  for (const { x, y } of points) {
    if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || ignoreHit?.(hit)) continue; // our own layer UI decides nothing
    if (hit === element || shadowInclusiveContains(element, hit) || shadowInclusiveContains(hit, element)) continue;
    const candidate = liftCandidateOnChain(hit, element);
    if (candidate) candidates.add(candidate);
  }

  if (candidates.size > MAX_LIFT_CANDIDATES) return [];

  // Full qualification (subtree media scan, stacking-context chain) once per distinct
  // candidate, only on this throttled path.
  return [...candidates].filter(qualifiesForLift);
};
