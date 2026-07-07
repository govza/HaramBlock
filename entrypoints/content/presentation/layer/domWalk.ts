/**
 * Shared shadow-DOM-aware tree walkers for the overlay layer modules
 * (geometryTracker, occlusion, captionLift).
 */

/** Parent element, crossing shadow boundaries via the host. */
export const parentOf = (element: Element): Element | null => {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
};

/**
 * Rendered (flattened-tree) parent: slotted elements paint inside their assigned
 * slot's shadow subtree, so stacking walks must go through `assignedSlot` — a plain
 * parentElement walk would skip shadow-internal wrappers and their z-indexes.
 */
export const flatParentOf = (element: Element): Element | null => element.assignedSlot ?? parentOf(element);

/** Ancestor check that crosses shadow boundaries via the host chain. */
export const shadowInclusiveContains = (ancestor: Element, node: Element): boolean => {
  for (let current: Element | null = node; current; current = parentOf(current)) {
    if (current === ancestor) return true;
  }
  return false;
};
