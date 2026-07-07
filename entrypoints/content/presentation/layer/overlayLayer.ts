import { captionLifter } from '@/entrypoints/content/presentation/layer/captionLift';
import { hasArea, isUnclipped, nextHostZ, MAX_Z_INDEX } from '@/entrypoints/content/presentation/layer/geometry';
import { GeometryTracker } from '@/entrypoints/content/presentation/layer/geometryTracker';

import type { ILayerGeometry, IOverlaySlot } from '@/utils/types/presentation';

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
}

const HOST_TAG = 'haramblock-overlay-layer';
// Interactive extension UI (the quick-toggle button) lives in its own host: the mask
// host's z-index is dynamic (kept just above the tracked elements, below higher-z site
// chrome), but a transient user-invoked control must never be buried under that chrome,
// so its host keeps the maximum z-index. A child cannot escape its host's stacking
// context, hence the separate element.
const UI_HOST_TAG = 'haramblock-overlay-ui';

const HOST_STYLE = [
  'position: fixed',
  'inset: 0',
  'width: 100%',
  'height: 100%',
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
  // Initial fail-closed value; syncHostZ lowers it to one above the highest z-index
  // on any tracked element's ancestor chain, so site chrome (sticky navbars,
  // dropdowns) with a higher z-index paints over masks exactly as it paints over
  // the masked elements themselves.
  `z-index: ${MAX_Z_INDEX}`,
].join('; ');

const SLOT_STYLE = 'position: absolute; top: 0; left: 0; display: none; pointer-events: none;';

/**
 * Extension-owned overlay layer: a single viewport-fixed host outside site DOM, holding
 * one slot per masked media element. Slots are positioned in viewport coordinates by a
 * shared GeometryTracker, so nothing is injected next to site elements and framework
 * re-renders can't remove overlays.
 *
 * Fullscreen: when a site element enters fullscreen, the host is promoted into the top
 * layer via the Popover API (later top-layer entries render above the fullscreen
 * element); browsers without popover fall back to reparenting the host into the
 * fullscreen element.
 */
class OverlayLayer {
  private host: HTMLElement | null = null;
  private root: HTMLDivElement | null = null;
  private uiHost: HTMLElement | null = null;
  private uiRoot: HTMLDivElement | null = null;
  private fullscreenWired = false;
  private readonly tracker = new GeometryTracker();
  private readonly slots = new Map<Element, InternalSlot>();

  attach(element: Element, hooks: IOverlaySlotHooks = {}, label = ''): IOverlaySlot {
    this.detach(element);

    const root = this.ensureRoot();
    const slotEl = document.createElement('div');
    slotEl.setAttribute('data-overlay-slot', label);
    slotEl.style.cssText = SLOT_STYLE;
    root.appendChild(slotEl);

    const internal: InternalSlot = { element, slotEl, hooks };
    this.slots.set(element, internal);

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
    // Synchronous raise: an element inside a high-z container must never get a frame
    // where it paints above its own mask. Lowering (after detach) happens lazily on
    // the tick heartbeat — late lowering is safe. Lifted captions follow the new
    // hostZ in the same breath.
    this.syncHostZ();
    this.syncLifts();

    return {
      root: slotEl,
      refresh: () => {
        this.tracker.refresh(element);
        // Same synchronous raise as attach: a refresh signals the element's ancestor
        // chain changed (e.g. reparented into a high-z container), so the host must
        // rise before the next paint, not a tick later.
        this.syncHostZ();
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
    // The tracker may have gone idle (no entries -> no ticks), so release this
    // entry's lifted captions here rather than waiting for a tick that never comes.
    this.syncLifts();
  }

  has(element: Element): boolean {
    return this.slots.has(element);
  }

  dispose(): void {
    this.tracker.dispose();
    this.slots.clear();
    captionLifter.dispose();
    document.removeEventListener('fullscreenchange', this.syncFullscreen);
    this.fullscreenWired = false;
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.uiHost?.remove();
    this.uiHost = null;
    this.uiRoot = null;
  }

  private position(internal: InternalSlot, { rect, clip, occluded }: ILayerGeometry): void {
    const { style } = internal.slotEl;
    if (!hasArea(rect) || clip === null || occluded) {
      style.display = 'none';
      return;
    }
    style.display = 'block';
    style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
    style.clipPath = isUnclipped(clip) ? '' : `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px)`;
  }

  private createHost(tag: string): { host: HTMLElement; root: HTMLDivElement } {
    const host = document.createElement(tag);
    host.style.cssText = HOST_STYLE;
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

  private ensureRoot(): HTMLDivElement {
    if (this.root && this.host?.isConnected) return this.root;

    if (!this.host) {
      const { host, root } = this.createHost(HOST_TAG);
      this.host = host;
      this.root = root;
      this.wireFullscreen();
      this.tracker.onTick = () => {
        this.ensureHostConnected();
        this.syncHostZ();
        this.syncLifts();
      };
      // Hits on our own hosts (e.g. the quick-toggle button) must not count as occluders
      this.tracker.shouldIgnoreOccluder = candidate => candidate === this.host || candidate === this.uiHost;
    }

    this.ensureHostConnected();
    return this.root as HTMLDivElement;
  }

  private ensureUiRoot(): HTMLDivElement {
    if (this.uiRoot && this.uiHost?.isConnected) return this.uiRoot;

    if (!this.uiHost) {
      const { host, root } = this.createHost(UI_HOST_TAG);
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
   * Detected caption overlays get an inline z-index one above the host, sandwiching
   * the mask between the image and its caption (see captionLift.ts). Runs wherever
   * syncHostZ runs, plus after detach so dropped entries release their captions.
   */
  private syncLifts(): void {
    captionLifter.sync(this.tracker.allLiftCandidates(), nextHostZ(this.tracker.maxChainZ()) + 1);
  }

  /**
   * Keeps the host z-index one above the highest z-index on any tracked element's
   * ancestor chain: masks always paint above their elements, while higher-z site
   * chrome (navbars, dropdowns, lightboxes) covers masks just like it covers the
   * elements themselves. Any failure falls back to the maximum (fail-closed).
   */
  private syncHostZ(): void {
    const { host } = this;
    if (!host) return;
    // A failed chain walk surfaces as Infinity, which nextHostZ clamps to the maximum.
    const value = String(nextHostZ(this.tracker.maxChainZ()));
    // Compare priority too: HOST_STYLE's initial z-index is a normal declaration, and
    // when the target value happens to equal it (chain at the maximum, failed walk) a
    // value-only check would never upgrade it — leaving site rules like
    // `haramblock-overlay-layer { z-index: 0 !important }` able to outrank us.
    if (host.style.getPropertyValue('z-index') !== value || host.style.getPropertyPriority('z-index') !== 'important') {
      // `important` outranks site stylesheets targeting our host tag.
      host.style.setProperty('z-index', value, 'important');
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
