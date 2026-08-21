import { clearSrcDriftHandler, setSrcDriftHandler } from '@/entrypoints/content/presentation/srcDrift';

/**
 * Sole owner of the image index and of converge dispatch: discovery
 * (`observed`) and reconciliation passes both exit through the one callback.
 * Keeps a dirty-set with a coalesced (microtask) reconcile pass, a safety tick that
 * reconciles everything, and per-root delegated capture load/error listeners
 * feeding the dirty-set. DomObserver owns root lifecycle and reports
 * discoveries/removals here.
 */
export class Reconciler {
  // Responsive images re-select a srcset candidate on resize without any
  // attribute mutation or load event on this root — the overlay's self-clean
  // is the only detector. It is just another change hint feeding the
  // dirty-set; the reconcile pass's processing path handles the invalidation.
  private readonly srcDriftHandler = (img: HTMLImageElement): void => {
    this.markDirty([img]);
  };

  private readonly trackedImages = new Set<HTMLImageElement>();
  private readonly dirtyImages = new Set<HTMLImageElement>();
  private reconcileScheduled = false;
  private safetyTickTimer: ReturnType<typeof setInterval> | null = null;
  // load/error don't bubble but do run the capture phase, so one listener per
  // tree root sees every image load in that tree. Non-composed events stay
  // inside their shadow tree, hence per-root installation. The self-add is
  // load-bearing: a fast image's load can fire before the async mutation
  // batch that would report it via observed().
  private readonly delegatedListener = (event: Event): void => {
    const { target } = event;
    if (target instanceof HTMLImageElement) {
      this.trackedImages.add(target);
      this.markDirty([target]);
    }
  };

  constructor(
    private readonly onMediaObserved: (images: HTMLImageElement[], videos: HTMLVideoElement[]) => void,
    /**
     * Disconnected images dropped by a reconcile pass or the safety tick. MutationObserver
     * never reports these (e.g. a removed shadow host takes its subtree silently),
     * so consumers must get their removal cleanup from here.
     */
    private readonly onPruned: (images: HTMLImageElement[]) => void,
    private readonly safetyTickInterval: number,
  ) {}

  public start(): void {
    setSrcDriftHandler(this.srcDriftHandler);
    this.safetyTickTimer ??= setInterval(() => this.reconcileAll(), this.safetyTickInterval);
  }

  public stop(): void {
    clearSrcDriftHandler(this.srcDriftHandler);
    if (this.safetyTickTimer !== null) {
      clearInterval(this.safetyTickTimer);
      this.safetyTickTimer = null;
    }
    this.trackedImages.clear();
    this.dirtyImages.clear();
    this.reconcileScheduled = false;
  }

  public attachRoot(root: Node): void {
    root.addEventListener('load', this.delegatedListener, true);
    root.addEventListener('error', this.delegatedListener, true);
  }

  public detachRoot(root: Node): void {
    root.removeEventListener('load', this.delegatedListener, true);
    root.removeEventListener('error', this.delegatedListener, true);
  }

  /** Discovery entry point: indexes the images and forwards both arrays to the callback synchronously. */
  public observed(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    if (images.length === 0 && videos.length === 0) return;
    for (const img of images) {
      this.trackedImages.add(img);
    }
    this.onMediaObserved(images, videos);
  }

  public removed(img: HTMLImageElement): void {
    this.trackedImages.delete(img);
    this.dirtyImages.delete(img);
  }

  private markDirty(images: Iterable<HTMLImageElement>): void {
    for (const img of images) {
      this.dirtyImages.add(img);
    }
    this.scheduleReconcile();
  }

  /** Broad invalidation for signals with no element mapping, e.g. verdict arrival. */
  public markAllDirty(): void {
    this.markDirty(this.trackedImages);
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
        this.removed(img);
        pruned.push(img);
      }
    }
    this.dirtyImages.clear();
    if (pruned.length > 0) {
      this.onPruned(pruned);
    }
    if (images.length > 0) {
      this.onMediaObserved(images, []);
    }
  }

  private reconcileAll(): void {
    const pruned: HTMLImageElement[] = [];
    for (const img of this.trackedImages) {
      if (!img.isConnected) {
        this.removed(img);
        pruned.push(img);
      }
    }
    if (pruned.length > 0) {
      this.onPruned(pruned);
    }
    this.markDirty(this.trackedImages);
  }
}
