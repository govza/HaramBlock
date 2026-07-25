/**
 * Viewport lifecycle for VideoSessions (docs/VIDEO_PROCESSING.md): a shared
 * IntersectionObserver suspends scrolled-away sessions (verdict state kept,
 * no captures or DVR work) and resumes them on re-entry. Sampler state is
 * reached only through the SuspensionSamplerPort, never directly.
 */

import type { SessionHandle } from '@/entrypoints/content/video/session/handle';
import type { SessionEvent } from '@/entrypoints/content/video/session/machine';

/** Keep near-viewport players warm while dropping scrolled-away feed videos. */
const VIDEO_VISIBILITY_ROOT_MARGIN_PX = 400;

/**
 * A masked playing video pays a full DVR teardown + re-warm (seconds of
 * whole-blur) and an audio-delay bounce per suspend/resume flip, so boundary
 * flapping in a virtualized feed (layout shifts, elastic scroll) must not
 * toggle suspension directly: leaving the margin only suspends after this
 * grace period; re-entering resumes immediately and cancels a pending suspend.
 */
const VIDEO_SUSPEND_GRACE_MS = 1_000;

export function isVideoNearViewport(video: HTMLVideoElement): boolean {
  if (typeof IntersectionObserver !== 'function') return true;
  const rect = video.getBoundingClientRect();
  // No layout box (display:none player behind a poster overlay, not laid out
  // yet): it can never intersect, but thumbnail capture works from data/poster
  // and the reveal must find its verdict ready. Only real scroll-aways suspend.
  if (rect.width <= 0 || rect.height <= 0) return true;
  return (
    rect.bottom >= -VIDEO_VISIBILITY_ROOT_MARGIN_PX &&
    rect.top <= globalThis.innerHeight + VIDEO_VISIBILITY_ROOT_MARGIN_PX &&
    rect.right >= 0 &&
    rect.left <= globalThis.innerWidth
  );
}

/** The sampler operations a suspend/resume flip needs (frameSampler.ts satisfies this). */
export interface SuspensionSamplerPort {
  startTicker(handle: SessionHandle): void;
  stopTicker(handle: SessionHandle): void;
  invalidateForSuspend(handle: SessionHandle): void;
  replayDeferredThumbnail(handle: SessionHandle): void;
  consumePendingResample(handle: SessionHandle): boolean;
  discardPendingResample(handle: SessionHandle): void;
}

export interface SuspensionPorts {
  /** Resolve the live handle for an observed element; observer entries can outlive their session. */
  handleFor(video: HTMLVideoElement): SessionHandle | undefined;
  dispatch(handle: SessionHandle, event: SessionEvent): void;
  sampler: SuspensionSamplerPort;
  /** Re-mask a static unsafe frame returning to view: whole blur + precise overlay. */
  reapplyStaticMask(handle: SessionHandle): void;
}

export class ViewportSuspension {
  private visibilityObserver: IntersectionObserver | null = null;

  constructor(private readonly ports: SuspensionPorts) {}

  observe(handle: SessionHandle): void {
    if (typeof IntersectionObserver !== 'function') return;
    this.visibilityObserver ??= new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const video = entry.target as HTMLVideoElement;
          const current = this.ports.handleFor(video);
          if (!current) continue;
          // Boxless players never intersect; mirror isVideoNearViewport's
          // carve-out so hidden-then-revealed videos keep their eager verdict.
          const rect = entry.boundingClientRect;
          const offscreen = !entry.isIntersecting && rect.width > 0 && rect.height > 0;
          this.requestSuspended(current, offscreen);
        }
      },
      { rootMargin: `${VIDEO_VISIBILITY_ROOT_MARGIN_PX}px 0px` },
    );
    this.visibilityObserver.observe(handle.video);
  }

  unobserve(video: HTMLVideoElement): void {
    this.visibilityObserver?.unobserve(video);
  }

  /** Suspension waits out a grace period so boundary flapping cannot thrash the DVR; resume is immediate. */
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

  clearGrace(handle: SessionHandle): void {
    if (handle.suspendGrace === null) return;
    clearTimeout(handle.suspendGrace);
    handle.suspendGrace = null;
  }

  private setSuspended(handle: SessionHandle, suspended: boolean): void {
    if (handle.suspended === suspended || handle.state.phase === 'disposed') return;
    handle.suspended = suspended;
    if (suspended) {
      // After handle.suspended is set: invalidateForSuspend arms the resume re-sample.
      this.ports.sampler.invalidateForSuspend(handle);
      // Reuse the machine's playback hand-back so DVR state, audio, and the
      // ring are released consistently, then stop frame delivery entirely.
      if (handle.state.phase === 'sampling') {
        this.ports.dispatch(handle, { type: 'pause', at: performance.now() });
      }
      this.ports.sampler.stopTicker(handle);
      return;
    }

    this.ports.sampler.startTicker(handle);
    this.ports.sampler.replayDeferredThumbnail(handle);
    if (!handle.video.paused && !handle.video.ended) {
      this.ports.sampler.discardPendingResample(handle); // fresh playback sampling supersedes it
      this.ports.dispatch(handle, { type: 'play', at: performance.now() });
    } else {
      if (handle.state.masked) {
        // Static unsafe frame returning to view: replace the coarse suspension
        // blur with its precise overlay now that it has real geometry again.
        this.ports.reapplyStaticMask(handle);
      }
      if (this.ports.sampler.consumePendingResample(handle)) {
        // A sample deflected during suspension (page-driven seek, cancelled
        // in-flight) left the displayed frame unverified, and a paused video
        // produces no further events — sample it like a fresh seek.
        this.ports.dispatch(handle, { type: 'seeked', at: performance.now(), timestampSec: handle.video.currentTime });
      }
    }
  }
}
