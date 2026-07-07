import { flatParentOf, parentOf } from '@/entrypoints/content/presentation/layer/domWalk';
import { createsStackingContext, MAX_Z_INDEX } from '@/entrypoints/content/presentation/layer/geometry';

/**
 * Caption lift: site captions (text bars, gradient scrims) that paint above a masked
 * element at the z-index:auto level would be covered by the mask — the mask host is
 * tree-last, so any host z-index that beats the image also beats every same-level
 * caption. The fix is on the caption's side: give it an inline z-index one above the
 * host, sandwiching the mask between the image and the caption. The mask is never
 * cut; image pixels under the caption stay masked.
 *
 * Safety model: candidates come from hit tests over the masked element, so they
 * already paint ABOVE the image — lifting preserves the site's visual order and only
 * inserts the mask below them. Every qualification failure leaves the caption covered
 * (fail-closed):
 *  - z-index must apply (positioned, or flex/grid item) — we never add `position`;
 *  - no media content in the subtree (a lifted element must not be able to display
 *    image pixels above the mask), no url() backgrounds;
 *  - no stacking-context ancestor other than the root (a caption flattened into a
 *    nested context can't escape above the mask no matter its z-index).
 */

// Bare <svg> is deliberately allowed: caption bars routinely carry inline icon svgs
// (play buttons, badge icons) that cannot display raster content — only <image> and
// <foreignObject> inside an svg can, and those are listed.
const MEDIA_SELECTOR = 'img,video,canvas,picture,iframe,object,embed,image,foreignObject';

/** Subtrees larger than this are not captions; skip instead of scanning (fail-closed). */
const MAX_SUBTREE_ELEMENTS = 50;

/** True when a numeric z-index would take effect on this node (positioned/flex/grid item). */
const zIndexApplies = (node: HTMLElement): boolean => {
  if (getComputedStyle(node).position !== 'static') return true;
  const parent = parentOf(node);
  return parent !== null && /flex|grid/.test(getComputedStyle(parent).display);
};

/** No media elements or url() backgrounds anywhere in the candidate's subtree. */
const isMediaFree = (candidate: HTMLElement): boolean => {
  if (candidate.matches(MEDIA_SELECTOR) || candidate.querySelector(MEDIA_SELECTOR)) return false;
  const descendants = candidate.querySelectorAll('*');
  if (descendants.length > MAX_SUBTREE_ELEMENTS) return false;
  if (getComputedStyle(candidate).backgroundImage.includes('url(')) return false;
  for (const node of descendants) {
    if (getComputedStyle(node).backgroundImage.includes('url(')) return false;
  }
  return true;
};

/**
 * The lift only works when the candidate participates in the ROOT stacking context:
 * any provable stacking-context ancestor flattens the caption into that ancestor's
 * paint layer (shared with the image in the common card case), where no z-index can
 * beat the host.
 */
const chainAllowsLift = (candidate: HTMLElement): boolean => {
  for (let node = flatParentOf(candidate); node && node !== document.documentElement; node = flatParentOf(node)) {
    if (createsStackingContext(getComputedStyle(node))) return false;
  }
  return true;
};

/**
 * Full qualification for a would-be lift candidate. Called from the occlusion slow
 * scan (throttled), not per frame.
 */
export const qualifiesForLift = (candidate: HTMLElement): boolean =>
  zIndexApplies(candidate) && isMediaFree(candidate) && chainAllowsLift(candidate);

/** Cheap node-local pre-filter used while choosing the candidate on a hit chain. */
export const mayQualifyForLift = (node: HTMLElement): boolean => zIndexApplies(node);

interface LiftState {
  /** Inline z-index value/priority before we touched it, for exact restore. */
  originalInlineZ: string;
  originalInlinePriority: string;
  /** Computed z-index before the lift — substituted into chainMaxZ walks. */
  originalComputedZ: string;
  appliedZ: string;
}

class CaptionLifter {
  private readonly lifted = new Map<HTMLElement, LiftState>();

  /**
   * Reconciles the lifted set with the current union of detected candidates:
   * lifts new ones to `liftZ`, re-asserts the inline style if the site re-rendered
   * it away, updates when `liftZ` changed (hostZ moved), restores dropped ones.
   * Candidates are pre-qualified by the slow scan; this runs per tick and does no
   * layout reads beyond inline-style string compares.
   */
  sync(candidates: ReadonlySet<HTMLElement>, liftZ: number): void {
    const appliedZ = String(Math.min(liftZ, MAX_Z_INDEX));

    for (const [element, state] of this.lifted) {
      if (!candidates.has(element) || !element.isConnected) {
        this.restore(element, state);
        this.lifted.delete(element);
      }
    }

    for (const element of candidates) {
      const state = this.lifted.get(element);
      if (!state) {
        this.lifted.set(element, {
          originalInlineZ: element.style.getPropertyValue('z-index'),
          originalInlinePriority: element.style.getPropertyPriority('z-index'),
          originalComputedZ: getComputedStyle(element).zIndex,
          appliedZ,
        });
        element.style.setProperty('z-index', appliedZ);
        continue;
      }
      state.appliedZ = appliedZ;
      // Self-heal: re-assert if the site re-rendered our inline style away or liftZ moved.
      if (element.style.getPropertyValue('z-index') !== appliedZ) {
        element.style.setProperty('z-index', appliedZ);
      }
    }
  }

  /**
   * Pre-lift computed z-index for a node we lifted, or null. chainMaxZ substitutes it
   * so a masked element that appears INSIDE a lifted caption can't feed our own lift
   * value back into hostZ (hostZ -> lift -> chainZ -> hostZ would spiral to the max).
   */
  unliftedZIndexOf(node: Element, computedZ: string): string | null {
    const state = node instanceof HTMLElement ? this.lifted.get(node) : undefined;
    return state && computedZ === state.appliedZ ? state.originalComputedZ : null;
  }

  /** Restores every lifted element (extension teardown). */
  dispose(): void {
    for (const [element, state] of this.lifted) {
      this.restore(element, state);
    }
    this.lifted.clear();
  }

  private restore(element: HTMLElement, state: LiftState): void {
    if (!element.isConnected) return;
    // Only undo our own write; leave any newer site-set inline value alone.
    if (element.style.getPropertyValue('z-index') !== state.appliedZ) return;
    if (state.originalInlineZ) {
      element.style.setProperty('z-index', state.originalInlineZ, state.originalInlinePriority);
    } else {
      element.style.removeProperty('z-index');
    }
  }
}

// Export singleton instance (one lifter per document, shared by tracker and layer)
export const captionLifter = new CaptionLifter();
