import { type ComposedTreeRoot, walkComposedTree } from '@/entrypoints/content/core/composedTreeWalk';
import { Reconciler } from '@/entrypoints/content/core/Reconciler';

export interface DomObserverConfig {
  onMediaObserved: (images: HTMLImageElement[], videos: HTMLVideoElement[]) => void;
  onMediaRemoved: (elements: HTMLElement[]) => void;
  onAttributesChanged: (elements: HTMLElement[]) => void;
  safetyTickIntervalMs?: number;
}

const SHADOW_RECHECK_INTERVAL_MS = 250;

const DEFAULT_SAFETY_TICK_INTERVAL_MS = 2000;

export class DomObserver {
  private observer: MutationObserver | null = null;
  private rootNode: Node | null = null;
  private shadowObservers = new Map<ShadowRoot, MutationObserver>();
  private pendingAttributeChanges = new Set<HTMLElement>();
  private pendingShadowHosts = new Set<Element>();
  private shadowRecheckTimer: ReturnType<typeof setInterval> | null = null;

  private readonly reconciler: Reconciler;

  constructor(private config: DomObserverConfig) {
    this.reconciler = new Reconciler(
      (images, videos) => this.config.onMediaObserved(images, videos),
      images => this.config.onMediaRemoved(images),
      config.safetyTickIntervalMs ?? DEFAULT_SAFETY_TICK_INTERVAL_MS,
    );
  }

  public start(root: Node = document): void {
    if (this.observer) return;
    this.rootNode = root;
    this.reconciler.attachRoot(root);

    if (isComposedTreeRoot(root)) {
      const { images, videos } = this.observeSubtree(root);
      this.reconciler.observed(images, videos);
    }

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

  public markAllDirty(): void {
    this.reconciler.markAllDirty();
  }

  private observeSubtree(root: ComposedTreeRoot): { images: HTMLImageElement[]; videos: HTMLVideoElement[] } {
    const { images, videos, shadowRoots, possibleHosts } = walkComposedTree(root);
    for (const shadowRoot of shadowRoots) {
      if (shadowRoot === this.rootNode || this.shadowObservers.has(shadowRoot)) continue;
      const observer = this.createObserver();
      observer.observe(shadowRoot, this.getObserverOptions());
      this.shadowObservers.set(shadowRoot, observer);
      this.reconciler.attachRoot(shadowRoot);
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
        this.reconciler.observed(images, videos);
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
        if (target.tagName === 'IMG' || target.tagName === 'VIDEO') {
          this.pendingAttributeChanges.add(target);
        }
      }
    }

    this.reconciler.observed(addedImages, addedVideos);

    const trulyRemoved = removedElements.filter(el => !el.isConnected);
    if (trulyRemoved.length > 0) {
      for (const el of trulyRemoved) {
        if (el.tagName === 'IMG') this.reconciler.removed(el as HTMLImageElement);
      }
      this.config.onMediaRemoved(trulyRemoved);
    }

    if (this.pendingAttributeChanges.size > 0) {
      const elements = Array.from(this.pendingAttributeChanges);
      this.pendingAttributeChanges.clear();
      this.config.onAttributesChanged(elements);
    }
  }

  private stopObservingShadowRoot(shadowRoot: ShadowRoot): void {
    const observer = this.shadowObservers.get(shadowRoot);
    if (!observer) return;
    observer.disconnect();
    this.shadowObservers.delete(shadowRoot);
    this.reconciler.detachRoot(shadowRoot);
  }
}

const isComposedTreeRoot = (node: Node): node is ComposedTreeRoot =>
  node.nodeType === Node.ELEMENT_NODE ||
  node.nodeType === Node.DOCUMENT_NODE ||
  node.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
