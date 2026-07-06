import {
  clipsEqual,
  computeClipInsets,
  hasArea,
  parseZIndex,
  rectsEqual,
} from '@/entrypoints/content/presentation/layer/geometry';
import { isElementOccluded } from '@/entrypoints/content/presentation/layer/occlusion';

import type { IClipInsets, ILayerGeometry, ILayerRect } from '@/utils/types/presentation';

export interface IGeometryTrackerCallbacks {
  /** Fired when the element's viewport rect or clip changed (and once at track time). */
  onUpdate: (geometry: ILayerGeometry) => void;
  /** Fired when the element left the document; the entry is already untracked. */
  onDetach: () => void;
}

interface TrackerEntry {
  element: Element;
  callbacks: IGeometryTrackerCallbacks;
  /** Ancestors with non-visible overflow, cached at track time. */
  clipAncestors: Element[];
  /** Highest numeric z-index on the element's flattened ancestor chain (see chainMaxZ). */
  chainZ: number;
  lastRect?: ILayerRect;
  lastClip?: IClipInsets | null;
  occluded: boolean;
  /** Timestamp of the last slow scan (occlusion hit-testing + chainZ re-walk). */
  slowScannedAt: number;
  intersecting: boolean;
  dirty: boolean;
}

/** Viewport-margin inside which elements are treated as visible (keeps near-viewport overlays warm). */
const INTERSECTION_MARGIN = '100px';

/**
 * Occlusion uses hit testing (forced layout per sample point) and the chainZ walk
 * reads computed styles up the ancestor chain, so this slow scan runs at most this
 * often per element — a lightbox appearing or a container's z-index changing is a
 * user-visible transition where ~200 ms of latency is imperceptible, unlike
 * per-frame position tracking.
 */
const SLOW_SCAN_INTERVAL_MS = 200;

const rectOf = (element: Element): ILayerRect => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
};

/** Padding-box rect of a clipping ancestor (excludes borders and scrollbars). */
const clipRectOf = (ancestor: Element): ILayerRect => {
  const rect = ancestor.getBoundingClientRect();
  return {
    top: rect.top + ancestor.clientTop,
    left: rect.left + ancestor.clientLeft,
    width: ancestor.clientWidth,
    height: ancestor.clientHeight,
  };
};

/** Parent element, crossing shadow boundaries via the host. */
const parentOf = (element: Element): Element | null => {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
};

/**
 * Rendered (flattened-tree) parent: slotted elements paint inside their assigned
 * slot's shadow subtree, so the walk must go through `assignedSlot` — a plain
 * parentElement walk would skip shadow-internal wrappers and their z-indexes.
 */
const flatParentOf = (element: Element): Element | null => {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
};

/**
 * Highest numeric z-index on the element's flattened ancestor chain (element
 * included, documentElement excluded), floored at 0.
 *
 * One above this value is guaranteed to paint over the element in the root stacking
 * context: the element's root-level stacking ancestor either has a numeric z-index
 * (which is on this chain) or stacks at the auto/0 level (beaten by z-index 1).
 * z-indexes trapped inside nested stacking contexts only OVERestimate — the mask
 * floats above more site content than strictly needed, never below its own element.
 * A failed walk returns Infinity, which the layer clamps to the maximum (fail-closed).
 */
const chainMaxZ = (element: Element): number => {
  try {
    let max = 0;
    for (let node: Element | null = element; node && node !== document.documentElement; node = flatParentOf(node)) {
      const z = parseZIndex(getComputedStyle(node).zIndex);
      if (z !== null && z > max) max = z;
    }
    return max;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * Ancestors that clip descendants (computed overflow other than visible). The root
 * scroller (html/body) is excluded — its scrolling is already reflected in viewport
 * coordinates.
 */
const findClipAncestors = (element: Element): Element[] => {
  const result: Element[] = [];
  for (let node = parentOf(element); node; node = parentOf(node)) {
    if (node === document.documentElement || node === document.body) continue;
    const style = getComputedStyle(node);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      result.push(node);
    }
  }
  return result;
};

/**
 * One tracker per overlay layer. Watches tracked elements' viewport geometry with a
 * single shared rAF sweep:
 *
 * - Elements near the viewport (IntersectionObserver-gated) are polled every frame —
 *   the only way to follow CSS-transform movement (carousels) without per-frame lag.
 * - Off-viewport elements are only re-read when marked dirty (scroll/resize/ResizeObserver).
 * - Detached elements are auto-untracked and reported via onDetach.
 *
 * All rect reads happen together before any callback runs, so renderer style writes
 * never interleave with layout reads.
 */
export class GeometryTracker {
  private readonly entries = new Map<Element, TrackerEntry>();
  private intersectionObserver?: IntersectionObserver;
  private resizeObserver?: ResizeObserver;
  private rafId: number | null = null;
  private listenersInstalled = false;

  /** Heartbeat invoked once per sweep; the layer uses it to self-heal its host element. */
  onTick?: () => void;

  /** Occluder veto (e.g. the layer's own host); such hits never count for occlusion. */
  shouldIgnoreOccluder?: (candidate: Element) => boolean;

  track(element: Element, callbacks: IGeometryTrackerCallbacks): void {
    this.untrack(element);

    const entry: TrackerEntry = {
      element,
      callbacks,
      clipAncestors: findClipAncestors(element),
      // Computed synchronously so the layer can raise its host z-index before the
      // initial geometry callback paints the first mask frame.
      chainZ: chainMaxZ(element),
      occluded: false,
      slowScannedAt: 0,
      // Assume visible until the IntersectionObserver reports, so the first frames poll.
      intersecting: true,
      dirty: true,
    };
    this.entries.set(element, entry);

    this.ensureInfra();
    this.intersectionObserver?.observe(element);
    this.resizeObserver?.observe(element);

    // Deliver initial geometry synchronously: consumers position + draw before the
    // next paint, leaving no unmasked frame between attach and the first sweep.
    this.readEntry(entry);
    this.schedule();
  }

  untrack(element: Element): void {
    const entry = this.entries.get(element);
    if (!entry) return;
    this.entries.delete(element);
    this.intersectionObserver?.unobserve(element);
    this.resizeObserver?.unobserve(element);
  }

  /** Force a geometry re-read for one element on the next sweep. */
  refresh(element: Element): void {
    const entry = this.entries.get(element);
    if (!entry) return;
    entry.dirty = true;
    entry.clipAncestors = findClipAncestors(element);
    entry.chainZ = chainMaxZ(element);
    this.schedule();
  }

  /** Highest chainZ across all tracked elements; the layer derives its host z-index from it. */
  maxChainZ(): number {
    let max = 0;
    for (const entry of this.entries.values()) {
      if (entry.chainZ > max) max = entry.chainZ;
    }
    return max;
  }

  dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.intersectionObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.intersectionObserver = undefined;
    this.resizeObserver = undefined;
    if (this.listenersInstalled) {
      document.removeEventListener('scroll', this.markAllDirty, true);
      globalThis.removeEventListener('resize', this.markAllDirty);
      document.removeEventListener('fullscreenchange', this.markAllDirty);
      this.listenersInstalled = false;
    }
    this.entries.clear();
  }

  private ensureInfra(): void {
    if (!this.listenersInstalled) {
      // Capture-phase scroll catches nested scrollers (scroll doesn't bubble).
      document.addEventListener('scroll', this.markAllDirty, { capture: true, passive: true });
      globalThis.addEventListener('resize', this.markAllDirty);
      document.addEventListener('fullscreenchange', this.markAllDirty);
      this.listenersInstalled = true;
    }
    this.intersectionObserver ??= new IntersectionObserver(
      observed => {
        for (const record of observed) {
          const entry = this.entries.get(record.target);
          if (entry) {
            entry.intersecting = record.isIntersecting;
            if (record.isIntersecting) entry.dirty = true;
          }
        }
        this.schedule();
      },
      { rootMargin: INTERSECTION_MARGIN },
    );
    this.resizeObserver ??= new ResizeObserver(observed => {
      for (const record of observed) {
        const entry = this.entries.get(record.target);
        if (entry) entry.dirty = true;
      }
      this.schedule();
    });
  }

  private readonly markAllDirty = (): void => {
    for (const entry of this.entries.values()) {
      entry.dirty = true;
    }
    this.schedule();
  };

  private schedule(): void {
    if (this.rafId !== null || this.entries.size === 0) return;
    this.rafId = requestAnimationFrame(this.sweep);
  }

  private readonly sweep = (): void => {
    this.rafId = null;
    this.onTick?.();

    const detached: TrackerEntry[] = [];
    const updates: { entry: TrackerEntry; geometry: ILayerGeometry }[] = [];

    // Read phase: no callbacks yet, so consumer style writes can't thrash layout.
    for (const entry of this.entries.values()) {
      if (!entry.element.isConnected) {
        detached.push(entry);
        continue;
      }
      if (!entry.intersecting && !entry.dirty) continue;
      const geometry = this.measure(entry);
      entry.dirty = false;
      const unchanged =
        rectsEqual(entry.lastRect, geometry.rect) &&
        clipsEqual(entry.lastClip, geometry.clip) &&
        geometry.occluded === entry.occluded;
      entry.lastRect = geometry.rect;
      entry.lastClip = geometry.clip;
      entry.occluded = geometry.occluded;
      if (unchanged) continue;
      updates.push({ entry, geometry });
    }

    // Write phase.
    for (const entry of detached) {
      this.untrack(entry.element);
      entry.callbacks.onDetach();
    }
    for (const { entry, geometry } of updates) {
      entry.callbacks.onUpdate(geometry);
    }

    this.schedule();
  };

  private measure(entry: TrackerEntry): ILayerGeometry {
    const rect = rectOf(entry.element);
    const clip = hasArea(rect) ? computeClipInsets(rect, entry.clipAncestors.map(clipRectOf)) : null;
    return { rect, clip, occluded: this.slowScan(entry, rect, clip) };
  }

  /**
   * Throttled slow path: occlusion hit testing and the chainZ ancestor re-walk are
   * comparatively expensive, and both change on user-visible transitions where
   * ~200 ms of latency is imperceptible.
   */
  private slowScan(entry: TrackerEntry, rect: ILayerRect, clip: IClipInsets | null): boolean {
    const now = Date.now();
    if (now - entry.slowScannedAt < SLOW_SCAN_INTERVAL_MS) return entry.occluded;
    entry.slowScannedAt = now;
    entry.chainZ = chainMaxZ(entry.element);
    if (!hasArea(rect) || clip === null) return false;
    return isElementOccluded(entry.element, rect, clip, this.shouldIgnoreOccluder);
  }

  private readEntry(entry: TrackerEntry): void {
    const geometry = this.measure(entry);
    entry.dirty = false;
    entry.lastRect = geometry.rect;
    entry.lastClip = geometry.clip;
    entry.occluded = geometry.occluded;
    entry.callbacks.onUpdate(geometry);
  }
}
