import {
  assertAnchorNameOn,
  restoreAnchorNameOn,
  type IPriorAnchor,
} from '@/entrypoints/content/presentation/layer/anchorName';
import { captionLifter } from '@/entrypoints/content/presentation/layer/captionLift';
import {
  hasArea,
  isUnclipped,
  nextSlotCorrection,
  nextSlotZ,
  MAX_Z_INDEX,
  type ISlotCorrection,
} from '@/entrypoints/content/presentation/layer/geometry';
import { GeometryTracker } from '@/entrypoints/content/presentation/layer/geometryTracker';

import type { ILayerGeometry, ILayerRect, IOverlaySlot } from '@/utils/types/presentation';

export interface IOverlaySlotHooks {
  /** Called with fresh geometry after the layer has positioned the slot (and once at attach). */
  onGeometry?: (geometry: ILayerGeometry) => void;
  /** Called when the tracked element left the document; the slot is already released. */
  onDetach?: () => void;
}

interface InternalSlot {
  element: Element;
  slotEl: HTMLDivElement;
  hooks: IOverlaySlotHooks;
  /** Tree-unique anchor name tying the slot to its element via CSS anchor positioning. */
  anchorName: string;
  /**
   * The element's own inline `anchor-name` from before attach: composed into what we
   * assert (anchor-name is a list — site anchored UI keeps working) and restored on
   * detach.
   */
  priorAnchor?: IPriorAnchor;
  /** Element rect from the last visible position(); target for the glue correction. */
  lastRect?: ILayerRect;
  /** Corrective translate currently applied to the slot (see syncCorrections). */
  correction?: ISlotCorrection;
}

/** Inline style of an element that has one (HTML or SVG), else null. */
const inlineStyleOf = (element: Element): CSSStyleDeclaration | null =>
  element instanceof HTMLElement || element instanceof SVGElement ? element.style : null;

const HOST_TAG = 'haramblock-overlay-layer';
// Interactive extension UI (the quick-toggle button) lives in its own host: slot
// z-indexes stay just above their tracked elements (below higher-z site chrome), but
// a transient user-invoked control must never be buried under that chrome, so the UI
// host keeps the maximum z-index.
const UI_HOST_TAG = 'haramblock-overlay-ui';

// The mask host is a zero-size static grouping node that deliberately creates NO
// stacking context (no fixed/sticky, no z-index, full opacity, no transform/filter):
// its fixed slots then stack in the ROOT context, each with its own z-index, so site
// chrome covers each mask exactly as it covers that mask's element.
const HOST_STYLE = [
  'position: absolute',
  'top: 0',
  'left: 0',
  'width: 0',
  'height: 0',
  // Explicit resets double as overrides for UA [popover] styles when the host is
  // promoted to the top layer during fullscreen.
  'margin: 0',
  'padding: 0',
  'border: none',
  'background: transparent',
  'overflow: visible',
  'pointer-events: none',
  // The host tag is a custom-element name that is never registered, so site FOUC
  // guards like `:not(:defined) { visibility: hidden }` (Reddit) match it and hide
  // every mask. Inline !important outranks any author rule; display stays a normal
  // declaration so the UA popover rules keep working during fullscreen promotion.
  'display: block',
  'visibility: visible !important',
].join('; ');

const UI_HOST_STYLE = [
  'position: fixed',
  'inset: 0',
  'width: 100%',
  'height: 100%',
  'margin: 0',
  'padding: 0',
  'border: none',
  'background: transparent',
  'overflow: visible',
  'pointer-events: none',
  'display: block',
  'visibility: visible !important',
].join('; ');

// Slots are placed by CSS anchor positioning: the compositor keeps them glued to
// their elements during scroll, which JS repositioning cannot (it runs a frame late).
// `fixed` so the containing block is the viewport (an anchor must descend from the
// positioned element's containing block). Everything is `!important` because slots
// live in the mask host's light DOM (see createMaskHost) where site CSS can reach
// them. The initial z-index is fail-closed; syncSlotZs lowers it before first paint.
const SLOT_STYLE = [
  'position: fixed !important',
  'display: none !important',
  'margin: 0 !important',
  'visibility: visible !important',
  'pointer-events: none !important',
  `z-index: ${MAX_Z_INDEX} !important`,
].join('; ');

/**
 * Extension-owned overlay layer: a single host outside site DOM, holding one slot per
 * masked media element. Slots are glued to their elements by CSS anchor positioning
 * (compositor-synced, zero scroll lag) and each carries its own z-index — one above
 * its element's stacking chain — so site chrome (lightbox backdrops, navbars) covers
 * a mask exactly as it covers that mask's element. The shared GeometryTracker
 * supplies size, clip, and detach signals. Nothing is injected next to site elements
 * and framework re-renders can't remove overlays.
 *
 * Fullscreen: when a site element enters fullscreen, the host is promoted into the top
 * layer via the Popover API (later top-layer entries render above the fullscreen
 * element); browsers without popover fall back to reparenting the host into the
 * fullscreen element.
 */
class OverlayLayer {
  private host: HTMLElement | null = null;
  private uiHost: HTMLElement | null = null;
  private uiRoot: HTMLDivElement | null = null;
  private fullscreenWired = false;
  private anchorSeq = 0;
  private readonly tracker = new GeometryTracker();
  private readonly slots = new Map<Element, InternalSlot>();

  attach(element: Element, hooks: IOverlaySlotHooks = {}, label = ''): IOverlaySlot {
    this.detach(element);

    const anchorName = `--haramblock-anchor-${++this.anchorSeq}`;
    const root = this.ensureRoot();
    const slotEl = document.createElement('div');
    slotEl.setAttribute('data-overlay-slot', label);
    slotEl.style.cssText = SLOT_STYLE;
    slotEl.style.setProperty('position-anchor', anchorName, 'important');
    slotEl.style.setProperty('top', 'anchor(top, 0px)', 'important');
    slotEl.style.setProperty('left', 'anchor(left, 0px)', 'important');
    // A display-hidden anchor is invalid, dropping the slot to its 0px fallbacks at
    // the viewport origin until the next sweep hides it — the browser hides it the
    // same frame where position-visibility is supported. Two passes: no engine
    // implements `anchors-valid` yet, and ONE unknown keyword invalidates the WHOLE
    // declaration — an invalid setProperty is a no-op, so the lone `anchors-visible`
    // survives as the fallback wherever the combined form fails to parse.
    slotEl.style.setProperty('position-visibility', 'anchors-visible', 'important');
    slotEl.style.setProperty('position-visibility', 'anchors-valid anchors-visible', 'important');
    root.appendChild(slotEl);

    const internal: InternalSlot = { element, slotEl, hooks, anchorName };
    this.slots.set(element, internal);
    this.assertAnchorName(internal);

    this.tracker.track(element, {
      onUpdate: geometry => {
        this.position(internal, geometry);
        hooks.onGeometry?.(geometry);
      },
      onDetach: () => {
        this.detach(element);
        hooks.onDetach?.();
      },
    });
    // Synchronous: an element inside a high-z container must never get a frame where
    // it paints above its own mask (the slot starts fail-closed at the maximum and is
    // lowered here). Lifted captions follow in the same breath.
    this.syncSlotZs();
    this.syncLifts();

    return {
      root: slotEl,
      refresh: () => {
        this.tracker.refresh(element);
        // Same synchronous sync as attach: a refresh signals the element's ancestor
        // chain changed (e.g. reparented into a high-z container), so the slot must
        // follow before the next paint, not a tick later.
        this.syncSlotZs();
        this.syncLifts();
      },
      release: () => this.detach(element),
    };
  }

  /**
   * Mounts an interactive extension UI element (e.g. the quick-toggle button) into the
   * always-on-top UI host. The host itself is pointer-transparent; the mounted element
   * gets pointer-events back.
   */
  mountUI(element: HTMLElement): void {
    const root = this.ensureUiRoot();
    element.style.pointerEvents = 'auto';
    root.appendChild(element);
  }

  /**
   * Adds a stylesheet inside the UI host's shadow root (where mounted UI lives) —
   * page-level injected CSS cannot cross the shadow boundary. Returns a remover.
   */
  addStyles(cssText: string): () => void {
    this.ensureUiRoot();
    const style = document.createElement('style');
    style.textContent = cssText;
    this.uiRoot?.parentNode?.insertBefore(style, this.uiRoot);
    return () => style.remove();
  }

  detach(element: Element): void {
    const internal = this.slots.get(element);
    if (!internal) return;
    this.slots.delete(element);
    this.tracker.untrack(element);
    internal.slotEl.remove();
    this.restoreAnchorName(internal);
    // The tracker may have gone idle (no entries -> no ticks), so release this
    // entry's lifted captions here rather than waiting for a tick that never comes.
    this.syncLifts();
  }

  /**
   * Inline + `important` so site rules can't outrank it, composed with the element's
   * own anchor-name list; re-run from the slow scan because framework re-renders
   * rewrite style attributes. See anchorName.ts for the bookkeeping.
   */
  private assertAnchorName(internal: InternalSlot): void {
    const style = inlineStyleOf(internal.element);
    if (!style) return;
    internal.priorAnchor = assertAnchorNameOn(style, internal.anchorName, internal.priorAnchor);
  }

  /** Undo our inline `anchor-name` unless the site has already overwritten it. */
  private restoreAnchorName(internal: InternalSlot): void {
    const style = inlineStyleOf(internal.element);
    if (!style) return;
    restoreAnchorNameOn(style, internal.anchorName, internal.priorAnchor);
  }

  has(element: Element): boolean {
    return this.slots.has(element);
  }

  dispose(): void {
    this.tracker.dispose();
    for (const internal of this.slots.values()) this.restoreAnchorName(internal);
    this.slots.clear();
    captionLifter.dispose();
    document.removeEventListener('fullscreenchange', this.syncFullscreen);
    this.fullscreenWired = false;
    this.host?.remove();
    this.host = null;
    this.uiHost?.remove();
    this.uiHost = null;
    this.uiRoot = null;
  }

  private position(internal: InternalSlot, { rect, clip }: ILayerGeometry): void {
    const { style } = internal.slotEl;
    if (!hasArea(rect) || clip === null) {
      internal.lastRect = undefined;
      style.setProperty('display', 'none', 'important');
      return;
    }
    // top/left come from anchor(); JS owns only size and clip (scroll-invariant).
    internal.lastRect = rect;
    style.setProperty('display', 'block', 'important');
    style.setProperty('width', `${rect.width}px`, 'important');
    style.setProperty('height', `${rect.height}px`, 'important');
    if (isUnclipped(clip)) {
      style.removeProperty('clip-path');
    } else {
      style.setProperty(
        'clip-path',
        `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px)`,
        'important',
      );
    }
  }

  /**
   * The mask host has NO shadow root: anchor names are tree-scoped and current
   * engines do not resolve an outer-tree `anchor-name` from inside a shadow root
   * (anchor() falls back and every slot collapses to the viewport origin). Slots
   * therefore live in the host's light DOM, shielded from site CSS by all-important
   * inline styles instead of a shadow boundary.
   */
  private createMaskHost(tag: string): HTMLElement {
    const host = document.createElement(tag);
    host.style.cssText = HOST_STYLE;
    return host;
  }

  private createUiHost(tag: string): { host: HTMLElement; root: HTMLDivElement } {
    const host = document.createElement(tag);
    host.style.cssText = UI_HOST_STYLE;
    // Open on purpose: the shadow root isolates our styles/queries from the site
    // either way, while 'closed' would offer no real protection (a hostile page can
    // remove the host itself) and would block e2e assertions and user debugging.
    const shadow = host.attachShadow({ mode: 'open' });
    const root = document.createElement('div');
    root.style.cssText = 'position: absolute; inset: 0; pointer-events: none;';
    shadow.appendChild(root);
    return { host, root };
  }

  private wireFullscreen(): void {
    if (this.fullscreenWired) return;
    this.fullscreenWired = true;
    document.addEventListener('fullscreenchange', this.syncFullscreen);
  }

  private ensureRoot(): HTMLElement {
    if (this.host?.isConnected) return this.host;

    if (!this.host) {
      this.host = this.createMaskHost(HOST_TAG);
      this.wireFullscreen();
      this.tracker.onTick = () => {
        this.ensureHostConnected();
        this.syncCorrections();
        this.syncSlotZs();
        this.syncLifts();
      };
      this.tracker.onSlowScan = element => {
        const internal = this.slots.get(element);
        if (internal) this.assertAnchorName(internal);
      };
      // Hits on our own hosts (e.g. the quick-toggle button) must never become
      // caption candidates; slots are light-DOM children, so match by containment.
      this.tracker.shouldIgnoreHit = candidate =>
        Boolean(this.host?.contains(candidate)) || Boolean(this.uiHost?.contains(candidate));
    }

    this.ensureHostConnected();
    return this.host;
  }

  private ensureUiRoot(): HTMLDivElement {
    if (this.uiRoot && this.uiHost?.isConnected) return this.uiRoot;

    if (!this.uiHost) {
      const { host, root } = this.createUiHost(UI_HOST_TAG);
      // Unlike the mask host, the UI host stays at the maximum: a transient
      // user-invoked control must not be buried under site chrome. Set with
      // `important` so site rules targeting our tag cannot outrank it.
      host.style.setProperty('z-index', String(MAX_Z_INDEX), 'important');
      this.uiHost = host;
      this.uiRoot = root;
      this.wireFullscreen();
    }

    this.ensureHostConnected();
    return this.uiRoot as HTMLDivElement;
  }

  /**
   * Detected caption overlays get an inline z-index one above their mask's slot,
   * sandwiching the mask between the image and its caption (see captionLift.ts).
   * Runs wherever syncSlotZs runs, plus after detach so dropped entries release
   * their captions.
   */
  private syncLifts(): void {
    const lifts = new Map<HTMLElement, number>();
    for (const [candidate, chainZ] of this.tracker.allLiftCandidates()) {
      lifts.set(candidate, nextSlotZ(chainZ) + 1);
    }
    captionLifter.sync(lifts);
  }

  /**
   * Glue safety net: anchor positioning is trusted but verified. Each sweep compares
   * every visible slot's ACTUAL position against its element's rect (the sweep just
   * read it) and, on disagreement, writes a corrective translate pulling the mask
   * back onto its image. Healthy anchors resolve to a zero delta and no style is
   * ever written — the cost is one getBoundingClientRect per visible slot per sweep.
   * Pathological anchor resolution (duplicate anchor names cloned by the site, engine
   * bugs — seen in the wild: Firefox resolving anchors half-a-box off on Bing's image
   * viewer — transformed carousels per the OVERLAY.md watch item) degrades to
   * one-frame-lag JS following instead of a misplaced mask, which would be fail-open.
   * Reads are batched before writes to avoid layout thrash inside the tick.
   */
  private syncCorrections(): void {
    const reads: Array<{ internal: InternalSlot; target: ILayerRect; actual: DOMRect }> = [];
    for (const internal of this.slots.values()) {
      const { lastRect } = internal;
      if (!lastRect) continue; // hidden or never positioned
      reads.push({ internal, target: lastRect, actual: internal.slotEl.getBoundingClientRect() });
    }
    for (const { internal, target, actual } of reads) {
      const current = internal.correction ?? { x: 0, y: 0 };
      const next = nextSlotCorrection(target, actual, current);
      if (!next) continue;
      internal.correction = next;
      internal.slotEl.style.setProperty('transform', `translate(${next.x}px, ${next.y}px)`, 'important');
    }
  }

  /**
   * Keeps each slot's z-index one above its element's stacking chain: the mask
   * always paints above its element, while higher-z site chrome (navbars, dropdowns,
   * lightbox backdrops) covers the mask just like it covers the element itself. Any
   * failure falls back to the maximum (fail-closed).
   */
  private syncSlotZs(): void {
    for (const [element, internal] of this.slots) {
      // A failed chain walk surfaces as Infinity, which nextSlotZ clamps to the maximum.
      const value = String(nextSlotZ(this.tracker.chainZOf(element) ?? Number.POSITIVE_INFINITY));
      const { style } = internal.slotEl;
      // Compare priority too, not just value: should the initial declaration ever be
      // (or become) non-important, a value-only check would never upgrade it, leaving
      // site rules like `[data-overlay-slot] { z-index: 0 !important }` able to
      // outrank us.
      if (style.getPropertyValue('z-index') !== value || style.getPropertyPriority('z-index') !== 'important') {
        style.setProperty('z-index', value, 'important');
      }
    }
  }

  /** Self-heal: re-append the hosts if the site removed them, and keep fullscreen state in sync. */
  private ensureHostConnected(): void {
    let reappended = false;
    for (const host of [this.host, this.uiHost]) {
      if (host && !host.isConnected) {
        document.documentElement.appendChild(host);
        reappended = true;
      }
    }
    if (reappended) this.syncFullscreen();
  }

  private readonly syncFullscreen = (): void => {
    // Mask host first: with popover promotion, later top-layer entries paint above
    // earlier ones, so the UI host (and its button) stays above the masks.
    for (const host of [this.host, this.uiHost]) {
      if (host) this.syncFullscreenHost(host);
    }
  };

  private syncFullscreenHost(host: HTMLElement): void {
    const { fullscreenElement } = document;

    if (fullscreenElement && fullscreenElement !== host) {
      if (typeof host.showPopover === 'function') {
        host.setAttribute('popover', 'manual');
        try {
          if (!host.matches(':popover-open')) host.showPopover();
        } catch {
          // Not connected or invalid state; the next tick's self-heal retries.
          host.removeAttribute('popover');
        }
      } else {
        // Legacy fallback: live inside the fullscreen subtree.
        fullscreenElement.appendChild(host);
      }
      return;
    }

    if (typeof host.hidePopover === 'function') {
      try {
        if (host.matches(':popover-open')) host.hidePopover();
      } catch {
        // no-op
      }
      host.removeAttribute('popover');
    }
    if (host.parentNode !== document.documentElement) {
      document.documentElement.appendChild(host);
    }
  }
}

// Export singleton instance (one layer per document)
export const overlayLayer = new OverlayLayer();
