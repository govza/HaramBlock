import { type ComposedTreeRoot, walkComposedTree } from '@/entrypoints/content/core/composedTreeWalk';
import { clearSrcDriftHandler, setSrcDriftHandler } from '@/entrypoints/content/presentation/srcDrift';

export interface DomObserverConfig {
  onMediaObserved: (images: HTMLImageElement[], videos: HTMLVideoElement[]) => void;
  onMediaRemoved: (images: HTMLImageElement[], videos: HTMLVideoElement[]) => void;
  onVideoAttributesChanged: (videos: HTMLVideoElement[]) => void;
  safetyTickIntervalMs?: number;
}

const SHADOW_RECHECK_INTERVAL_MS = 250;

const DEFAULT_SAFETY_TICK_INTERVAL_MS = 2000;

const MARK_ALL_DIRTY_COALESCE_MS = 100;

export class DomObserver {
  private observer: MutationObserver | null = null;
  private rootNode: Node | null = null;
  private shadowObservers = new Map<ShadowRoot, MutationObserver>();
  private pendingVideoAttributeChanges = new Set<HTMLVideoElement>();
  private pendingShadowHosts = new Set<Element>();
  private shadowRecheckTimer: ReturnType<typeof setInterval> | null = null;

  private readonly trackedImages = new Set<HTMLImageElement>();
  private readonly dirtyImages = new Set<HTMLImageElement>();
  private reconcileScheduled = false;
  private safetyTickTimer: ReturnType<typeof setInterval> | null = null;
  private markAllDirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly safetyTickInterval: number;

  private readonly srcDriftHandler = (img: HTMLImageElement): void => {
    this.markDirty([img]);
  };

  private readonly delegatedListener = (event: Event): void => {
    const { target } = event;
    if (target instanceof HTMLImageElement) {
      this.trackedImages.add(target);
      this.markDirty([target]);
    }
  };

  constructor(private config: DomObserverConfig) {
    this.safetyTickInterval = config.safetyTickIntervalMs ?? DEFAULT_SAFETY_TICK_INTERVAL_MS;
  }

  public start(root: Node = document): void {
    if (this.observer) return;
    this.rootNode = root;
    this.addCaptureListeners(root);

    if (isComposedTreeRoot(root)) {
      const { images, videos } = this.observeSubtree(root);
      this.trackAndReport(images, videos);
    }

    this.observer = this.createObserver();
    this.observer.observe(root, this.getObserverOptions());

    setSrcDriftHandler(this.srcDriftHandler);
    this.safetyTickTimer ??= setInterval(() => this.safetyTick(), this.safetyTickInterval);
  }

  public stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.rootNode) {
      this.removeCaptureListeners(this.rootNode);
      this.rootNode = null;
    }
    for (const [shadowRoot, observer] of this.shadowObservers) {
      observer.disconnect();
      this.removeCaptureListeners(shadowRoot);
    }
    this.shadowObservers.clear();
    this.pendingVideoAttributeChanges.clear();
    this.pendingShadowHosts.clear();
    if (this.shadowRecheckTimer !== null) {
      clearInterval(this.shadowRecheckTimer);
      this.shadowRecheckTimer = null;
    }
    clearSrcDriftHandler(this.srcDriftHandler);
    if (this.safetyTickTimer !== null) {
      clearInterval(this.safetyTickTimer);
      this.safetyTickTimer = null;
    }
    if (this.markAllDirtyTimer !== null) {
      clearTimeout(this.markAllDirtyTimer);
      this.markAllDirtyTimer = null;
    }
    this.trackedImages.clear();
    this.dirtyImages.clear();
    this.reconcileScheduled = false;
  }

  public markAllDirty(): void {
    this.markAllDirtyTimer ??= setTimeout(() => {
      this.markAllDirtyTimer = null;
      this.markDirty(this.trackedImages);
    }, MARK_ALL_DIRTY_COALESCE_MS);
  }

  public findTrackedImagesBySrc(src: string): HTMLImageElement[] {
    const results: HTMLImageElement[] = [];
    for (const img of this.trackedImages) {
      if (!img.isConnected) continue;
      if ((img.currentSrc || img.src) === src) results.push(img);
    }
    return results;
  }

  private trackAndReport(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    if (images.length === 0 && videos.length === 0) return;
    for (const img of images) {
      this.trackedImages.add(img);
    }
    this.config.onMediaObserved(images, videos);
  }

  private untrack(img: HTMLImageElement): void {
    this.trackedImages.delete(img);
    this.dirtyImages.delete(img);
  }

  private markDirty(images: Iterable<HTMLImageElement>): void {
    for (const img of images) {
      this.dirtyImages.add(img);
    }
    this.scheduleReconcile();
  }

  private scheduleReconcile(): void {
    if (this.reconcileScheduled || this.dirtyImages.size === 0) return;
    this.reconcileScheduled = true;
    queueMicrotask(() => {
      this.reconcileScheduled = false;
      this.reconcile();
    });
  }

  private reconcile(): void {
    if (this.dirtyImages.size === 0) return;
    const images: HTMLImageElement[] = [];
    const pruned: HTMLImageElement[] = [];
    for (const img of this.dirtyImages) {
      if (img.isConnected) {
        images.push(img);
      } else {
        this.untrack(img);
        pruned.push(img);
      }
    }
    this.dirtyImages.clear();
    if (pruned.length > 0) {
      this.config.onMediaRemoved(pruned, []);
    }
    if (images.length > 0) {
      this.config.onMediaObserved(images, []);
    }
  }

  private safetyTick(): void {
    const pruned: HTMLImageElement[] = [];
    for (const img of this.trackedImages) {
      if (!img.isConnected) {
        this.untrack(img);
        pruned.push(img);
      }
    }
    if (pruned.length > 0) {
      this.config.onMediaRemoved(pruned, []);
    }
    this.markDirty(this.trackedImages);
  }

  private addCaptureListeners(root: Node): void {
    root.addEventListener('load', this.delegatedListener, true);
    root.addEventListener('error', this.delegatedListener, true);
  }

  private removeCaptureListeners(root: Node): void {
    root.removeEventListener('load', this.delegatedListener, true);
    root.removeEventListener('error', this.delegatedListener, true);
  }

  private observeSubtree(root: ComposedTreeRoot): { images: HTMLImageElement[]; videos: HTMLVideoElement[] } {
    const { images, videos, shadowRoots, possibleHosts } = walkComposedTree(root);
    for (const shadowRoot of shadowRoots) {
      if (shadowRoot === this.rootNode || this.shadowObservers.has(shadowRoot)) continue;
      const observer = this.createObserver();
      observer.observe(shadowRoot, this.getObserverOptions());
      this.shadowObservers.set(shadowRoot, observer);
      this.addCaptureListeners(shadowRoot);
    }
    for (const host of possibleHosts) {
      this.trackPossibleShadowHost(host);
    }
    return { images, videos };
  }

  private trackPossibleShadowHost(element: Element): void {
    if (this.pendingShadowHosts.has(element)) return;
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
        const { images, videos } = this.observeSubtree(root);
        this.trackAndReport(images, videos);
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
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const { images, videos } = this.observeSubtree(node as Element);
          addedImages.push(...images);
          addedVideos.push(...videos);
        }

        for (const node of mutation.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const { images, videos, shadowRoots } = walkComposedTree(node as Element);
          removedElements.push(...images, ...videos);
          for (const shadowRoot of shadowRoots) {
            this.stopObservingShadowRoot(shadowRoot);
          }
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target as HTMLElement;
        if (target.tagName === 'IMG') {
          this.trackedImages.add(target as HTMLImageElement);
          this.markDirty([target as HTMLImageElement]);
        } else if (target.tagName === 'VIDEO') {
          this.pendingVideoAttributeChanges.add(target as HTMLVideoElement);
        }
      }
    }

    this.trackAndReport(addedImages, addedVideos);

    const removedImages: HTMLImageElement[] = [];
    const removedVideos: HTMLVideoElement[] = [];
    for (const el of removedElements) {
      if (el.isConnected) continue;
      if (el.tagName === 'IMG') {
        this.untrack(el as HTMLImageElement);
        removedImages.push(el as HTMLImageElement);
      } else if (el.tagName === 'VIDEO') {
        removedVideos.push(el as HTMLVideoElement);
      }
    }
    if (removedImages.length > 0 || removedVideos.length > 0) {
      this.config.onMediaRemoved(removedImages, removedVideos);
    }

    if (this.pendingVideoAttributeChanges.size > 0) {
      const videos = Array.from(this.pendingVideoAttributeChanges);
      this.pendingVideoAttributeChanges.clear();
      this.config.onVideoAttributesChanged(videos);
    }
  }

  private stopObservingShadowRoot(shadowRoot: ShadowRoot): void {
    const observer = this.shadowObservers.get(shadowRoot);
    if (!observer) return;
    observer.disconnect();
    this.shadowObservers.delete(shadowRoot);
    this.removeCaptureListeners(shadowRoot);
  }
}

const isComposedTreeRoot = (node: Node): node is ComposedTreeRoot =>
  node.nodeType === Node.ELEMENT_NODE ||
  node.nodeType === Node.DOCUMENT_NODE ||
  node.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
