import { clearSrcDriftHandler, setSrcDriftHandler } from '@/entrypoints/content/presentation/srcDrift';

export class Reconciler {
  private readonly srcDriftHandler = (img: HTMLImageElement): void => {
    this.markDirty([img]);
  };

  private readonly trackedImages = new Set<HTMLImageElement>();
  private readonly dirtyImages = new Set<HTMLImageElement>();
  private reconcileScheduled = false;
  private safetyTickTimer: ReturnType<typeof setInterval> | null = null;

  private readonly delegatedListener = (event: Event): void => {
    const { target } = event;
    if (target instanceof HTMLImageElement) {
      this.trackedImages.add(target);
      this.markDirty([target]);
    }
  };

  constructor(
    private readonly onMediaObserved: (images: HTMLImageElement[], videos: HTMLVideoElement[]) => void,

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
