import { captionLifter } from '@/entrypoints/content/presentation/layer/captionLift';
import { scanLiftCandidates } from '@/entrypoints/content/presentation/layer/captionScan';
import { flatParentOf, parentOf } from '@/entrypoints/content/presentation/layer/domWalk';
import {
  clipsEqual,
  computeClipInsets,
  createsStackingContext,
  hasArea,
  mergeLiftCandidates,
  parseZIndex,
  rectsEqual,
} from '@/entrypoints/content/presentation/layer/geometry';

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
  /** Root-level stacking z-index estimate for the element's flattened chain (see chainMaxZ). */
  chainZ: number;
  /** Qualified caption-lift candidates from the last slow scan (see captionLift.ts). */
  liftCandidates: HTMLElement[];
  lastRect?: ILayerRect;
  lastClip?: IClipInsets | null;
  /** Timestamp of the last slow scan (caption hit-testing + chainZ re-walk). */
  slowScannedAt: number;
  intersecting: boolean;
  dirty: boolean;
}

/** Viewport-margin inside which elements are treated as visible (keeps near-viewport overlays warm). */
const INTERSECTION_MARGIN = '100px';

/**
 * Caption discovery uses hit testing (forced layout per sample point) and the chainZ
 * walk reads computed styles up the ancestor chain, so this slow scan runs at most
 * this often per element — a caption appearing or a container's z-index changing is a
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

/**
 * Estimate of the z-index that decides the element's paint level in the ROOT
 * stacking context, from a walk over its flattened ancestor chain (element included,
 * documentElement excluded), floored at 0.
 *
 * One above this value is guaranteed to paint over the element in the root stacking
 * context: the element's root-level stacking ancestor either has a numeric z-index
 * (kept by this walk) or stacks at the auto/0 level (beaten by z-index 1).
 *
 * Crossing a node that provably creates a stacking context DISCARDS the z-indexes
 * accumulated below it — they are trapped inside that context and can't affect root
 * paint order (a carousel's `.slick-active { z-index: 999 }` inside a transformed
 * track must not pin the slot at 1000 page-wide). The reset is safe because
 * `createsStackingContext` fires only on spec-certain triggers; a missed trigger
 * just leaves the old overestimate — masks float above more site content than
 * strictly needed, never below their own element.
 * A failed walk returns Infinity, which the layer clamps to the maximum (fail-closed).
 */
const chainMaxZ = (element: Element): number => {
  try {
    let max = 0;
    for (let node: Element | null = element; node && node !== document.documentElement; node = flatParentOf(node)) {
      const style = getComputedStyle(node);
      // A caption WE lifted must be walked with its pre-lift z-index, or a masked
      // element inside a lifted caption feeds our own lift value back into chainZ
      // (slotZ -> lift -> chainZ -> slotZ spirals to the maximum).
      const original = captionLifter.unliftedZIndexOf(node, style.zIndex);
      const z = parseZIndex(original ?? style.zIndex);
      const stacking =
        original === null
          ? style
          : {
              position: style.position,
              zIndex: original,
              transform: style.transform,
              filter: style.filter,
              opacity: style.opacity,
              isolation: style.isolation,
              mixBlendMode: style.mixBlendMode,
              perspective: style.perspective,
              backdropFilter: style.backdropFilter,
            };
      if (createsStackingContext(stacking)) {
        // Everything below paints inside this context; at the parent level only the
        // context's own z-index matters (auto/negative stack at or below the 0 level).
        max = z !== null && z > 0 ? z : 0;
      } else if (z !== null && z > max) {
        // Numeric z-index without a guaranteed stacking context: it may or may not
        // apply (static non-flex-item) — count it. Overestimates, never under.
        max = z;
      }
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

  /** Invoked per element on the throttled slow scan; the layer re-asserts anchor-names here. */
  onSlowScan?: (element: Element) => void;

  /** Hit veto (e.g. the layer's own hosts); such hits are never caption candidates. */
  shouldIgnoreHit?: (candidate: Element) => boolean;

  track(element: Element, callbacks: IGeometryTrackerCallbacks): void {
    this.untrack(element);

    const entry: TrackerEntry = {
      element,
      callbacks,
      clipAncestors: findClipAncestors(element),
      // Placeholder: the synchronous readEntry below runs slowScan (slowScannedAt 0
      // always passes the throttle), which walks the real chainZ before track()
      // returns — and before the layer's attach-time slot z-index sync reads it.
      chainZ: 0,
      liftCandidates: [],
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

  /** Root-level stacking z-index estimate for a tracked element's chain (see chainMaxZ). */
  chainZOf(element: Element): number | undefined {
    return this.entries.get(element)?.chainZ;
  }

  /**
   * Qualified caption-lift candidates across all tracked elements, each mapped to the
   * highest chainZ among the entries it overlaps — the base the lift z derives from.
   */
  allLiftCandidates(): Map<HTMLElement, number> {
    return mergeLiftCandidates(this.entries.values());
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
      const unchanged = rectsEqual(entry.lastRect, geometry.rect) && clipsEqual(entry.lastClip, geometry.clip);
      entry.lastRect = geometry.rect;
      entry.lastClip = geometry.clip;
      if (unchanged) continue;
      updates.push({ entry, geometry });
    }

    // Write phase. onTick leads it (after the reads, so a chainZ change picked up by
    // this sweep's slow scan reaches the slot z-indexes in the SAME frame the
    // masks repaint — a tick earlier and the raise would lag one sweep behind).
    this.onTick?.();
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
    this.slowScan(entry, rect, clip);
    return { rect, clip };
  }

  /**
   * Throttled slow path: caption hit testing and the chainZ ancestor re-walk are
   * comparatively expensive, and both change on user-visible transitions where
   * ~200 ms of latency is imperceptible.
   */
  private slowScan(entry: TrackerEntry, rect: ILayerRect, clip: IClipInsets | null): void {
    const now = Date.now();
    if (now - entry.slowScannedAt < SLOW_SCAN_INTERVAL_MS) return;
    entry.slowScannedAt = now;
    entry.chainZ = chainMaxZ(entry.element);
    this.onSlowScan?.(entry.element);
    if (!hasArea(rect) || clip === null) {
      // Hidden element: its mask can't paint, so no caption needs lifting either.
      entry.liftCandidates = [];
      return;
    }
    entry.liftCandidates = scanLiftCandidates(entry.element, rect, clip, this.shouldIgnoreHit);
  }

  private readEntry(entry: TrackerEntry): void {
    const geometry = this.measure(entry);
    entry.dirty = false;
    entry.lastRect = geometry.rect;
    entry.lastClip = geometry.clip;
    entry.callbacks.onUpdate(geometry);
  }
}
