const FORCED_POSITION_KEY = 'haramblockForcedPosition';

/**
 * Ensures the parent can act as the containing block for absolutely positioned
 * overlays. Forces `position: relative` only while the parent computes to
 * `static`, and re-evaluates previously forced parents on every call: site
 * styles applied after the first check (e.g. Reddit's <zoomable-img> gaining
 * `position: fixed` once its component mounts) must win over our stale inline
 * value, otherwise the site's own layout breaks.
 */
export function ensurePositionContext(parent: HTMLElement): void {
  if (FORCED_POSITION_KEY in parent.dataset) {
    parent.style.removeProperty('position');
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    } else {
      delete parent.dataset[FORCED_POSITION_KEY];
    }
    return;
  }
  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
    parent.dataset[FORCED_POSITION_KEY] = '';
  }
}

/**
 * Offset of an element's client rect inside the parent's content coordinate
 * space — the value to write to an absolutely positioned overlay's top/left.
 *
 * Client-rect deltas alone are wrong when the parent is a scrolled container:
 * they are visual coordinates (scroll already subtracted), while abs-pos
 * top/left resolve in content coordinates, so the overlay would land exactly
 * scrollTop/scrollLeft away from the element (Reddit's zoom view scrolls its
 * overflow-auto container to center the click point). Adding the parent's
 * scroll offset back converts to content coordinates; clientTop/clientLeft
 * account for the parent's border between its rect and its padding box.
 */
/**
 * Classifies a mutation batch for an overlay's cleanup observer.
 *
 * Frameworks (Reddit's Lit lightbox) constantly detach and re-insert nodes
 * during re-renders, so an ancestor appearing in removedNodes does NOT mean
 * the element left the page — tearing the mask down on that signal alone
 * removes masks from images that are still visible (fail-open). Only treat
 * the element as gone when it is actually disconnected once the batch has
 * settled; otherwise report a move so the caller can re-home the overlay
 * next to its element.
 */
export function classifyOverlayMutation(
  mutations: MutationRecord[],
  element: Element,
  overlay: Element,
): 'none' | 'moved' | 'detached' {
  let touched = false;
  for (const mutation of mutations) {
    for (const removedNode of mutation.removedNodes) {
      if (removedNode.nodeType !== Node.ELEMENT_NODE) continue;
      const el = removedNode as Element;
      if (removedNode === element || el.contains(element) || removedNode === overlay || el.contains(overlay)) {
        touched = true;
        break;
      }
    }
    if (touched) break;
  }
  if (!touched) return 'none';
  return element.isConnected ? 'moved' : 'detached';
}

export function overlayOffsetInParent(
  parent: HTMLElement,
  rect: DOMRect,
  parentRect: DOMRect,
): { top: number; left: number } {
  return {
    top: rect.top - parentRect.top + parent.scrollTop - parent.clientTop,
    left: rect.left - parentRect.left + parent.scrollLeft - parent.clientLeft,
  };
}
