import { hasArea, isUnclipped } from '@/entrypoints/content/presentation/layer/geometry';
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
const MAX_Z_INDEX = '2147483647';

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
  'display: block',
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
  private readonly tracker = new GeometryTracker();
  private readonly slots = new Map<Element, InternalSlot>();

  attach(element: Element, hooks: IOverlaySlotHooks = {}): IOverlaySlot {
    this.detach(element);

    const root = this.ensureRoot();
    const slotEl = document.createElement('div');
    slotEl.setAttribute('data-overlay-slot', '');
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

    return {
      root: slotEl,
      refresh: () => this.tracker.refresh(element),
      release: () => this.detach(element),
    };
  }

  /**
   * Mounts an interactive extension UI element (e.g. the quick-toggle button) into the
   * layer. The layer itself is pointer-transparent; the mounted element gets
   * pointer-events back.
   */
  mountUI(element: HTMLElement): void {
    const root = this.ensureRoot();
    element.style.pointerEvents = 'auto';
    root.appendChild(element);
  }

  /**
   * Adds a stylesheet inside the layer's shadow root — page-level injected CSS cannot
   * cross the shadow boundary. Returns a remover.
   */
  addStyles(cssText: string): () => void {
    this.ensureRoot();
    const style = document.createElement('style');
    style.textContent = cssText;
    this.root?.parentNode?.insertBefore(style, this.root);
    return () => style.remove();
  }

  detach(element: Element): void {
    const internal = this.slots.get(element);
    if (!internal) return;
    this.slots.delete(element);
    this.tracker.untrack(element);
    internal.slotEl.remove();
  }

  has(element: Element): boolean {
    return this.slots.has(element);
  }

  dispose(): void {
    this.tracker.dispose();
    this.slots.clear();
    document.removeEventListener('fullscreenchange', this.syncFullscreen);
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  private position(internal: InternalSlot, { rect, clip }: ILayerGeometry): void {
    const { style } = internal.slotEl;
    if (!hasArea(rect) || clip === null) {
      style.display = 'none';
      return;
    }
    style.display = 'block';
    style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
    style.clipPath = isUnclipped(clip) ? '' : `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px)`;
  }

  private ensureRoot(): HTMLDivElement {
    if (this.root && this.host?.isConnected) return this.root;

    if (!this.host) {
      const host = document.createElement(HOST_TAG);
      host.style.cssText = HOST_STYLE;
      const shadow = host.attachShadow({ mode: 'closed' });
      const root = document.createElement('div');
      root.style.cssText = 'position: absolute; inset: 0; pointer-events: none;';
      shadow.appendChild(root);
      this.host = host;
      this.root = root;
      document.addEventListener('fullscreenchange', this.syncFullscreen);
      this.tracker.onTick = () => this.ensureHostConnected();
    }

    this.ensureHostConnected();
    return this.root as HTMLDivElement;
  }

  /** Self-heal: re-append the host if the site removed it, and keep fullscreen state in sync. */
  private ensureHostConnected(): void {
    const { host } = this;
    if (!host) return;
    if (!host.isConnected) {
      document.documentElement.appendChild(host);
      this.syncFullscreen();
    }
  }

  private readonly syncFullscreen = (): void => {
    const { host } = this;
    if (!host) return;
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
  };
}

// Export singleton instance (one layer per document)
export const overlayLayer = new OverlayLayer();
