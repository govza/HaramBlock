import type { SessionHandle } from '@/entrypoints/content/video/session/handle';

const VIDEO_VISIBILITY_ROOT_MARGIN_PX = 400;
const VIDEO_SUSPEND_GRACE_MS = 1_000;

export function isVideoNearViewport(video: HTMLVideoElement): boolean {
  if (typeof IntersectionObserver !== 'function') return true;
  const rect = video.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return true;
  return (
    rect.bottom >= -VIDEO_VISIBILITY_ROOT_MARGIN_PX &&
    rect.top <= globalThis.innerHeight + VIDEO_VISIBILITY_ROOT_MARGIN_PX &&
    rect.right >= 0 &&
    rect.left <= globalThis.innerWidth
  );
}

/**
 * Registry hooks Viewport Suspension needs: look up the session of an observed video and report a
 * suspend/resume flip.
 */
export interface SuspensionPorts {
  handleFor(video: HTMLVideoElement): SessionHandle | undefined;
  suspendedChanged(handle: SessionHandle): void;
}

export class ViewportSuspension {
  private visibilityObserver: IntersectionObserver | null = null;

  constructor(private readonly ports: SuspensionPorts) {}

  observe(handle: SessionHandle): void {
    if (typeof IntersectionObserver !== 'function') return;
    this.visibilityObserver ??= new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const current = this.ports.handleFor(entry.target as HTMLVideoElement);
          if (!current) continue;
          const rect = entry.boundingClientRect;
          this.requestSuspended(current, !entry.isIntersecting && rect.width > 0 && rect.height > 0);
        }
      },
      { rootMargin: `${VIDEO_VISIBILITY_ROOT_MARGIN_PX}px 0px` },
    );
    this.visibilityObserver.observe(handle.video);
  }

  unobserve(video: HTMLVideoElement): void {
    this.visibilityObserver?.unobserve(video);
  }

  clearGrace(handle: SessionHandle): void {
    if (handle.suspendGrace === null) return;
    clearTimeout(handle.suspendGrace);
    handle.suspendGrace = null;
  }

  private requestSuspended(handle: SessionHandle, suspended: boolean): void {
    if (!suspended) {
      this.clearGrace(handle);
      this.setSuspended(handle, false);
      return;
    }
    if (handle.suspended || handle.suspendGrace !== null) return;
    handle.suspendGrace = setTimeout(() => {
      handle.suspendGrace = null;
      this.setSuspended(handle, true);
    }, VIDEO_SUSPEND_GRACE_MS);
  }

  private setSuspended(handle: SessionHandle, suspended: boolean): void {
    if (handle.suspended === suspended || handle.state.phase === 'disposed') return;
    handle.suspended = suspended;
    this.ports.suspendedChanged(handle);
  }
}
