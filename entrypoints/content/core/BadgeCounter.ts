import { backgroundRpc } from '@/utils/messaging/content';

const DEBOUNCE_MS = 500;

export class BadgeCounter {
  private readonly blockedSrcs = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentCount = -1;

  trackDetections(_img: HTMLImageElement, src: string, count: number): void {
    // The badge is a per-tab absolute count and the RPC carries no frame identity,
    // so with allFrames content scripts a subframe's counter would overwrite the top
    // document's count (last reporter wins). Subframe detections are masked but not
    // counted until the badge aggregates per frame.
    if (globalThis.self !== globalThis.top) return;
    if (count > 0 && !this.blockedSrcs.has(src)) {
      this.blockedSrcs.add(src);
      this.scheduleUpdate();
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleUpdate(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.sendUpdate();
    }, DEBOUNCE_MS);
  }

  private sendUpdate(): void {
    const total = this.blockedSrcs.size;
    if (total === this.lastSentCount) return;

    this.lastSentCount = total;
    void backgroundRpc.updateIconBadge(total, globalThis.location.href);
  }
}
