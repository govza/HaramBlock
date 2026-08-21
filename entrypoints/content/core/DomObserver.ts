import { Reconciler } from '@/entrypoints/content/core/Reconciler';

export interface DomObserverConfig {
  /**
   * Media the observer saw: at start, on mutation, and on reconciliation
   * reconciles of dirty (or, on the safety tick, all tracked) images — reconciles
   * pass an empty videos array. Must be idempotent — DOM signals are treated
   * as hints, and the reconcile pass converges state regardless of which signal fired.
   */
  onMediaObserved: (images: HTMLImageElement[], videos: HTMLVideoElement[]) => void;
  onMediaRemoved: (elements: HTMLElement[]) => void;
  onAttributesChanged: (elements: HTMLElement[]) => void;
  safetyTickInterval?: number; // ms
}

/**
 * Re-check cadence for elements that may attach a shadow root later. Bounds
 * how long media born inside such a root stays unprotected, so it errs low;
 * each check is a shadowRoot property read.
 */
const SHADOW_RECHECK_INTERVAL_MS = 250;

const DEFAULT_SAFETY_TICK_INTERVAL_MS = 2000;

export class DomObserver {
  private observer: MutationObserver | null = null;
  private rootNode: Node | null = null;
  private shadowObservers = new Map<ShadowRoot, MutationObserver>();
  private pendingAttributeChanges = new Set<HTMLElement>();
  // Custom elements seen before attachShadow ran (async-loaded components);
  // re-checked on an interval until a root appears or they disconnect.
  private pendingShadowHosts = new Set<Element>();
  private shadowRecheckTimer: ReturnType<typeof setInterval> | null = null;

  private readonly reconciler: Reconciler;

  constructor(private config: DomObserverConfig) {
    this.reconciler = new Reconciler(
      (images, videos) => this.config.onMediaObserved(images, videos),
      images => this.config.onMediaRemoved(images),
      config.safetyTickInterval ?? DEFAULT_SAFETY_TICK_INTERVAL_MS,
    );
  }

  public start(root: Node = document): void {
    if (this.observer) return;
    this.rootNode = root;
    this.reconciler.attachRoot(root);

    // Scan existing DOM for images/videos (including shadow roots)
    this.scanExistingElements(root);

    this.observer = this.createObserver();
    this.observer.observe(root, this.getObserverOptions());

    this.reconciler.start();
  }

  public stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.rootNode) {
      this.reconciler.detachRoot(this.rootNode);
      this.rootNode = null;
    }
    // Disconnect all shadow observers
    for (const [shadowRoot, observer] of this.shadowObservers) {
      observer.disconnect();
      this.reconciler.detachRoot(shadowRoot);
    }
    this.shadowObservers.clear();
    this.pendingAttributeChanges.clear();
    this.pendingShadowHosts.clear();
    if (this.shadowRecheckTimer !== null) {
      clearInterval(this.shadowRecheckTimer);
      this.shadowRecheckTimer = null;
    }
    this.reconciler.stop();
  }

  /** Broad invalidation for signals with no element mapping, e.g. verdict arrival. */
  public markAllDirty(): void {
    this.reconciler.markAllDirty();
  }

  // ===========================================================================
  // Root lifecycle
  // ===========================================================================

  /** Track a custom element that may attach a shadow root later. */
  private trackPossibleShadowHost(element: Element): void {
    if (!element.tagName.includes('-')) return;
    if (element.shadowRoot || this.pendingShadowHosts.has(element)) return;
    this.pendingShadowHosts.add(element);
    this.shadowRecheckTimer ??= setInterval(() => this.recheckPendingShadowHosts(), SHADOW_RECHECK_INTERVAL_MS);
  }

  private recheckPendingShadowHosts(): void {
    for (const element of this.pendingShadowHosts) {
      if (!element.isConnected) {
        this.pendingShadowHosts.delete(element);
        continue;
      }
      const root = element.shadowRoot;
      if (root) {
        this.pendingShadowHosts.delete(element);
        if (!this.shadowObservers.has(root)) this.observeShadowRoot(root);
      }
    }
    if (this.pendingShadowHosts.size === 0 && this.shadowRecheckTimer !== null) {
      clearInterval(this.shadowRecheckTimer);
      this.shadowRecheckTimer = null;
    }
  }

  private getObserverOptions(): MutationObserverInit {
    return {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src'],
      attributeOldValue: true,
    };
  }

  private createObserver(): MutationObserver {
    return new MutationObserver(mutations => this.handleMutations(mutations));
  }

  private handleMutations(mutations: MutationRecord[]): void {
    const addedImages: HTMLImageElement[] = [];
    const addedVideos: HTMLVideoElement[] = [];
    const removedElements: HTMLElement[] = [];

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        // Handle added nodes
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const element = node as HTMLElement;

            this.collectMediaFromElement(element, addedImages, addedVideos);
            // Check for shadow root on the element itself and its descendants
            this.observeShadowRoots(element);
          }
        }

        // Handle removed nodes
        if (mutation.removedNodes.length > 0) {
          for (const node of mutation.removedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const element = node as HTMLElement;

            this.collectRemovedMedia(element, removedElements);
            // Clean up shadow observers for removed elements
            this.cleanupShadowObservers(element);
          }
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target as HTMLElement;
        if (target.tagName === 'IMG' || target.tagName === 'VIDEO') {
          this.pendingAttributeChanges.add(target);
        }
      }
    }

    this.reconciler.observed(addedImages, addedVideos);

    // An element that is connected again by the end of the batch was reparented, not
    // removed (lightboxes, React portals moving live subtrees): reporting it as removed
    // would tear down its overlay state while it is still on screen.
    const trulyRemoved = removedElements.filter(el => !el.isConnected);
    if (trulyRemoved.length > 0) {
      for (const el of trulyRemoved) {
        if (el.tagName === 'IMG') this.reconciler.removed(el as HTMLImageElement);
      }
      this.config.onMediaRemoved(trulyRemoved);
    }

    // Process attribute changes immediately to prevent flash of unblurred content
    if (this.pendingAttributeChanges.size > 0) {
      const elements = Array.from(this.pendingAttributeChanges);
      this.pendingAttributeChanges.clear();
      this.config.onAttributesChanged(elements);
    }
  }

  private collectMediaFromElement(element: HTMLElement, images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    // Direct matches
    if (element.tagName === 'IMG') {
      images.push(element as HTMLImageElement);
    } else if (element.tagName === 'VIDEO') {
      videos.push(element as HTMLVideoElement);
    }

    // Find nested media elements (light DOM only, shadow DOM handled separately)
    element.querySelectorAll('img').forEach(img => images.push(img));
    element.querySelectorAll('video').forEach(video => videos.push(video));

    // Check if element has a shadow root and collect media from it
    if (element.shadowRoot) {
      this.collectMediaFromShadowRoot(element.shadowRoot, images, videos);
    }
  }

  private collectMediaFromShadowRoot(
    shadowRoot: ShadowRoot,
    images: HTMLImageElement[],
    videos: HTMLVideoElement[],
  ): void {
    shadowRoot.querySelectorAll('img').forEach(img => images.push(img));
    shadowRoot.querySelectorAll('video').forEach(video => videos.push(video));

    // Recursively check for nested shadow roots
    shadowRoot.querySelectorAll('*').forEach(el => {
      const nested = (el as HTMLElement).shadowRoot;
      if (nested) {
        this.collectMediaFromShadowRoot(nested, images, videos);
      }
    });
  }

  private collectRemovedMedia(element: HTMLElement, removed: HTMLElement[]): void {
    if (element.tagName === 'IMG' || element.tagName === 'VIDEO') {
      removed.push(element);
    }
    element.querySelectorAll('img,video').forEach(media => removed.push(media as HTMLElement));

    // Also collect from shadow roots
    if (element.shadowRoot) {
      element.shadowRoot.querySelectorAll('img,video').forEach(media => removed.push(media as HTMLElement));
    }
  }

  private observeShadowRoots(element: HTMLElement): void {
    // Check the element itself
    if (element.shadowRoot && !this.shadowObservers.has(element.shadowRoot)) {
      this.observeShadowRoot(element.shadowRoot);
    } else {
      this.trackPossibleShadowHost(element);
    }

    // Check all descendants for shadow roots
    element.querySelectorAll('*').forEach(el => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.shadowRoot && !this.shadowObservers.has(htmlEl.shadowRoot)) {
        this.observeShadowRoot(htmlEl.shadowRoot);
      } else {
        this.trackPossibleShadowHost(htmlEl);
      }
    });
  }

  private observeShadowRoot(shadowRoot: ShadowRoot): void {
    // Scan existing content in shadow root
    const images: HTMLImageElement[] = [];
    const videos: HTMLVideoElement[] = [];
    this.collectMediaFromShadowRoot(shadowRoot, images, videos);
    this.reconciler.observed(images, videos);

    // Create observer for this shadow root
    const observer = this.createObserver();
    observer.observe(shadowRoot, this.getObserverOptions());
    this.shadowObservers.set(shadowRoot, observer);
    this.reconciler.attachRoot(shadowRoot);

    // Also observe any nested shadow roots that already exist (and track
    // nested custom elements whose roots may attach later)
    shadowRoot.querySelectorAll('*').forEach(el => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.shadowRoot && !this.shadowObservers.has(htmlEl.shadowRoot)) {
        this.observeShadowRoot(htmlEl.shadowRoot);
      } else {
        this.trackPossibleShadowHost(htmlEl);
      }
    });
  }

  private cleanupShadowObservers(element: HTMLElement): void {
    // Clean up the element's own shadow root and any nested shadow roots within it
    if (element.shadowRoot) {
      this.cleanupShadowRoot(element.shadowRoot);
    }

    // Clean up observers for shadow roots in light DOM descendants
    element.querySelectorAll('*').forEach(el => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.shadowRoot) {
        this.cleanupShadowRoot(htmlEl.shadowRoot);
      }
    });
  }

  /**
   * Recursively clean up a shadow root and all nested shadow roots within it.
   */
  private cleanupShadowRoot(shadowRoot: ShadowRoot): void {
    // Disconnect observer for this shadow root
    const observer = this.shadowObservers.get(shadowRoot);
    if (observer) {
      observer.disconnect();
      this.shadowObservers.delete(shadowRoot);
      this.reconciler.detachRoot(shadowRoot);
    }

    // Recursively clean up nested shadow roots inside this shadow root
    shadowRoot.querySelectorAll('*').forEach(el => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.shadowRoot) {
        this.cleanupShadowRoot(htmlEl.shadowRoot);
      }
    });
  }

  private scanExistingElements(root: Node): void {
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;

    const container = root.nodeType === Node.DOCUMENT_NODE ? (root as Document).documentElement : (root as Element);
    if (!container) return;

    const existingImages: HTMLImageElement[] = [];
    const existingVideos: HTMLVideoElement[] = [];

    // Find all existing images and videos in light DOM
    container.querySelectorAll('img').forEach(img => existingImages.push(img));
    container.querySelectorAll('video').forEach(video => existingVideos.push(video));

    // Find and observe all existing shadow roots; track custom elements whose
    // roots may attach later (async-loaded components)
    container.querySelectorAll('*').forEach(el => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.shadowRoot && !this.shadowObservers.has(htmlEl.shadowRoot)) {
        this.observeShadowRoot(htmlEl.shadowRoot);
      } else {
        this.trackPossibleShadowHost(htmlEl);
      }
    });

    this.reconciler.observed(existingImages, existingVideos);
  }
}
