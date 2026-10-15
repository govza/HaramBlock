import { resolveImageSource } from '@/entrypoints/content/core/imageSource';
import { computeRenderedContentRect, type ContentRect } from '@/entrypoints/content/presentation/imageLayout';
import { notifySrcDrift } from '@/entrypoints/content/presentation/srcDrift';

export type AnchoredElement = HTMLImageElement | HTMLVideoElement;

/**
 * Where an anchored overlay sits, in the coordinates its own `top`/`left` resolve against, plus the
 * element's rendered content rect relative to the element box: what an adapter needs to paint.
 */
export interface OverlayGeometry {
  position: 'absolute' | 'fixed';
  top: number;
  left: number;
  width: number;
  height: number;
  content: ContentRect;
}

/**
 * How the overlay joins the element's stacking order. A `cover` is homed as the element's next
 * sibling and sized to its box; a `badge` (the quick-toggle button) is appended into the anchor
 * container just above the element and sizes and offsets itself in `onLayout`.
 */
export type OverlayStacking = 'cover' | 'badge';

/** Why an anchor gave up on its element: it left the page for good, or an image re-selected its source. */
export type AnchorLoss = 'detached' | 'src-drift';

/**
 * What an adapter supplies to keep an overlay glued to its media element: the stacking it needs,
 * whether an image's source drift ends the overlay, a painter for every fresh geometry, and the
 * teardown for when the anchor gives up.
 */
export interface AnchorOptions {
  stacking?: OverlayStacking;
  trackSrc?: boolean;
  onLayout?(geometry: OverlayGeometry): void;
  onLost(reason: AnchorLoss): void;
}

/**
 * A live anchoring of one overlay to one element. `refresh` re-homes and re-measures synchronously
 * and paints through `onLayout`; `dispose` stops tracking and removes the overlay.
 */
export interface OverlayAnchor {
  refresh(): OverlayGeometry | null;
  dispose(): void;
}

/**
 * Where to inject an overlay for an element. `container` receives the overlay; `box` is the
 * containing block positioning resolves against. They differ only for a direct child of a shadow
 * root (parentElement is null): the overlay must live inside the shadow tree, since a light-DOM
 * child of the host would not render without a matching <slot>, while the positioned shadow host
 * is its containing block in the flat tree.
 */
interface InjectionContext {
  container: HTMLElement | ShadowRoot;
  box: HTMLElement;
}

/**
 * Frames a disconnected element gets to come back before its overlay is given up: framework
 * re-renders (Reddit's Lit lightbox) detach and re-insert nodes across separate batches.
 */
const MAX_DETACHED_FRAMES = 30;

const BADGE_Z_LIFT = 2;

const FORCED_POSITION_KEY = 'haramblockForcedPosition';

/**
 * Keeps `overlay` positioned over `element` for as long as the anchor lives: homes it next to the
 * element (shadow-root aware), forces a position context on the containing block, follows resizes,
 * re-renders that move the element or drop the overlay, viewport resize and scroll, waits out
 * transient detachment, and reports the element's loss. Nothing is placed until the first
 * `refresh()`.
 */
export const anchorOverlay = (
  element: AnchoredElement,
  overlay: HTMLElement,
  options: AnchorOptions,
): OverlayAnchor => {
  const stacking = options.stacking ?? 'cover';
  const trackedSrc = options.trackSrc && element instanceof HTMLImageElement ? resolveImageSource(element) : null;
  let disposed = false;
  let layoutFrame: number | null = null;
  let reconnectFrame: number | null = null;
  let detachedFrames = 0;
  let observedBox: HTMLElement | null = null;
  let appliedBox = '';

  const hasDrifted = (): boolean =>
    trackedSrc !== null && element instanceof HTMLImageElement && resolveImageSource(element) !== trackedSrc;

  const lose = (reason: AnchorLoss): void => {
    dispose();
    options.onLost(reason);
    if (reason === 'src-drift' && element instanceof HTMLImageElement) notifySrcDrift(element);
  };

  const awaitReconnection = (): void => {
    if (reconnectFrame !== null) return;
    const poll = () => {
      reconnectFrame = null;
      if (disposed) return;
      if (element.isConnected) {
        refresh();
        return;
      }
      detachedFrames += 1;
      if (detachedFrames >= MAX_DETACHED_FRAMES) {
        lose('detached');
        return;
      }
      reconnectFrame = requestAnimationFrame(poll);
    };
    reconnectFrame = requestAnimationFrame(poll);
  };

  const observeBox = (box: HTMLElement): void => {
    if (observedBox === box) return;
    if (observedBox) resizeObserver.unobserve(observedBox);
    resizeObserver.observe(box);
    observedBox = box;
  };

  const home = (): HTMLElement | null => {
    if (!element.isConnected) {
      overlay.remove();
      awaitReconnection();
      return null;
    }
    detachedFrames = 0;
    const context = resolveInjectionContext(element);
    if (!context) return null;
    ensurePositionContext(context.box);
    if (!isHomed(element, overlay, context, stacking)) placeInStack(element, overlay, context, stacking);
    observeBox(context.box);
    return context.box;
  };

  const applyBox = (geometry: OverlayGeometry): void => {
    const key = [geometry.position, geometry.top, geometry.left, geometry.width, geometry.height].join(',');
    if (key === appliedBox) return;
    appliedBox = key;
    overlay.style.position = geometry.position;
    overlay.style.top = `${geometry.top}px`;
    overlay.style.left = `${geometry.left}px`;
    overlay.style.width = `${geometry.width}px`;
    overlay.style.height = `${geometry.height}px`;
  };

  const refresh = (): OverlayGeometry | null => {
    if (disposed) return null;
    if (hasDrifted()) {
      lose('src-drift');
      return null;
    }
    const box = home();
    if (!box) return null;
    const rect = element.getBoundingClientRect();
    const geometry: OverlayGeometry = {
      ...overlayPlacement(element, box, rect, box.getBoundingClientRect()),
      width: rect.width,
      height: rect.height,
      content: computeRenderedContentRect(element, rect),
    };
    if (stacking === 'cover') applyBox(geometry);
    options.onLayout?.(geometry);
    return geometry;
  };

  const scheduleRefresh = (): void => {
    if (disposed || layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      refresh();
    });
  };

  const resizeObserver = new ResizeObserver(() => refresh());
  resizeObserver.observe(element);

  const mutationObserver = new MutationObserver(mutations => {
    if (!touchesAnchoring(mutations, element, overlay)) return;
    home();
    scheduleRefresh();
  });
  mutationObserver.observe(element.ownerDocument, { childList: true, subtree: true });
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) mutationObserver.observe(root, { childList: true, subtree: true });

  globalThis.addEventListener('resize', scheduleRefresh);
  globalThis.addEventListener('scroll', scheduleRefresh, { passive: true });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    globalThis.removeEventListener('resize', scheduleRefresh);
    globalThis.removeEventListener('scroll', scheduleRefresh);
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    if (reconnectFrame !== null) cancelAnimationFrame(reconnectFrame);
    overlay.remove();
  };

  return { refresh, dispose };
};

/**
 * Whether a mutation batch removed the element (or an ancestor) or the overlay (or an ancestor).
 * Frameworks re-insert nodes within the same batch during re-renders, so removal alone does not
 * mean the element left the page; the caller re-homes and lets connectivity decide.
 */
const touchesAnchoring = (mutations: MutationRecord[], element: Element, overlay: Element): boolean =>
  mutations.some(mutation =>
    Array.from(mutation.removedNodes).some(
      node => node === element || node === overlay || node.contains(element) || node.contains(overlay),
    ),
  );

const resolveInjectionContext = (element: HTMLElement): InjectionContext | null => {
  const parent = resolveAnchorParent(element);
  if (parent) return { container: parent, box: parent };
  const root = element.getRootNode();
  if (root instanceof ShadowRoot && root.host instanceof HTMLElement) {
    return { container: root, box: root.host };
  }
  return null;
};

/**
 * A cover is inserted directly after its element with the element's own z-index, so it paints
 * above the element (later sibling) but below player chrome stacked over it: appending into the
 * container with `z-index: element + 1` out-stacked `z-index: auto` chrome sharing that container
 * (Facebook Reels' Unmute button). Fixed-position elements keep container injection: sibling
 * insertion could let an intermediate positioned ancestor capture the overlay away from the anchor
 * box the offset math resolves against. A badge always goes into the container, stacked above the
 * element and its cover.
 */
const placeInStack = (
  element: HTMLElement,
  overlay: HTMLElement,
  context: InjectionContext,
  stacking: OverlayStacking,
): void => {
  if (stacking === 'cover' && isSiblingHomed(element)) {
    element.after(overlay);
    const { zIndex } = getComputedStyle(element);
    overlay.style.zIndex = zIndex === 'auto' ? '' : zIndex;
    return;
  }
  context.container.appendChild(overlay);
  const elementZIndex = parseInt(getComputedStyle(element).zIndex) || 0;
  overlay.style.zIndex = `${elementZIndex + (stacking === 'badge' ? BADGE_Z_LIFT : 1)}`;
};

const isHomed = (
  element: HTMLElement,
  overlay: HTMLElement,
  context: InjectionContext,
  stacking: OverlayStacking,
): boolean => {
  if (stacking === 'cover' && isSiblingHomed(element)) return overlay.previousElementSibling === element;
  return overlay.parentNode === context.container;
};

const isSiblingHomed = (element: HTMLElement): boolean =>
  element.parentNode !== null && getComputedStyle(element).position !== 'fixed';

/**
 * Top-level image documents ("open image in new tab") lay out the img with UA rules — Firefox uses
 * `position: absolute; inset: 0; margin: auto` against the initial containing block. Forcing
 * `position: relative` on the empty body shrinks that containing block to zero height and shoves
 * the image half off-screen. Overlays on the static body resolve against the ICB, whose origin
 * matches the zero-margin body, so no position context is needed.
 */
const isImageDocumentBody = (parent: HTMLElement): boolean =>
  parent === parent.ownerDocument.body && parent.ownerDocument.contentType.startsWith('image/');

/**
 * Ensures the box can act as the containing block for absolutely positioned overlays. Forces
 * `position: relative` only while it computes to `static`, and re-evaluates previously forced boxes
 * on every call: site styles applied after the first check (e.g. Reddit's <zoomable-img> gaining
 * `position: fixed` once its component mounts) must win over our stale inline value, otherwise the
 * site's own layout breaks. Must run before the box's rect is read.
 */
const ensurePositionContext = (parent: HTMLElement): void => {
  if (isImageDocumentBody(parent)) {
    if (FORCED_POSITION_KEY in parent.dataset) {
      parent.style.removeProperty('position');
      delete parent.dataset[FORCED_POSITION_KEY];
    }
    return;
  }
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
};

/**
 * The parent whose box anchors overlays for this element: the direct parent, or for an absolutely
 * positioned element its containing block — forcing `position: relative` onto a static parent
 * would re-anchor the element and can break its layout. A fixed element's containing block is the
 * viewport unless an ancestor forms one (transform/perspective/filter and friends); for a truly
 * viewport-fixed element fall back to <body>, where forcing `position: relative` cannot re-anchor
 * it and the rect-based offset math stays correct.
 */
const resolveAnchorParent = (element: HTMLElement): HTMLElement | null => {
  const parent = element.parentElement;
  if (!parent) return null;
  const { position } = getComputedStyle(element);
  if (position === 'absolute') {
    let ancestor: HTMLElement | null = parent;
    while (ancestor && getComputedStyle(ancestor).position === 'static') {
      ancestor = ancestor.parentElement;
    }
    return ancestor ?? parent;
  }
  if (position === 'fixed') {
    let ancestor: HTMLElement | null = parent;
    while (ancestor && !formsFixedContainingBlock(ancestor)) {
      ancestor = ancestor.parentElement;
    }
    return ancestor ?? document.body ?? parent;
  }
  return parent;
};

const formsFixedContainingBlock = (el: HTMLElement): boolean => {
  const style = getComputedStyle(el);
  return (
    style.transform !== 'none' ||
    style.perspective !== 'none' ||
    style.filter !== 'none' ||
    style.backdropFilter !== 'none' ||
    /transform|perspective|filter/.test(style.willChange) ||
    style.contain === 'strict' ||
    style.contain === 'content' ||
    style.contain.includes('paint') ||
    style.contain.includes('layout')
  );
};

const flatTreeParent = (el: HTMLElement): HTMLElement | null => {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
};

const isViewportFixed = (element: HTMLElement): boolean => {
  if (getComputedStyle(element).position !== 'fixed') return false;
  for (let ancestor = flatTreeParent(element); ancestor; ancestor = flatTreeParent(ancestor)) {
    if (formsFixedContainingBlock(ancestor)) return false;
  }
  return true;
};

/**
 * A viewport-fixed element does not move on scroll while an abs-pos overlay in its anchor box
 * does, so the overlay must itself be `position: fixed` at the element's viewport coordinates;
 * everything else anchors absolutely in the box's content coordinate space.
 */
const overlayPlacement = (
  element: HTMLElement,
  box: HTMLElement,
  rect: DOMRect,
  boxRect: DOMRect,
): Pick<OverlayGeometry, 'position' | 'top' | 'left'> => {
  if (isViewportFixed(element)) {
    return { position: 'fixed', top: rect.top, left: rect.left };
  }
  return { position: 'absolute', ...overlayOffsetInBox(box, rect, boxRect) };
};

/**
 * Client-rect deltas alone are wrong when the box is a scrolled container: they are visual
 * coordinates (scroll already subtracted), while abs-pos top/left resolve in content coordinates,
 * so the overlay would land exactly scrollTop/scrollLeft away from the element (Reddit's zoom view
 * scrolls its overflow-auto container to center the click point). Adding the scroll offset back
 * converts to content coordinates; clientTop/clientLeft account for the border between its rect
 * and its padding box.
 */
const overlayOffsetInBox = (box: HTMLElement, rect: DOMRect, boxRect: DOMRect): { top: number; left: number } => ({
  top: rect.top - boxRect.top + box.scrollTop - box.clientTop,
  left: rect.left - boxRect.left + box.scrollLeft - box.clientLeft,
});
