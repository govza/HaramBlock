import {
  applyBlacklistStyling,
  PROCESSED_ATTR_MAP,
  resetImageStyling,
} from '@/entrypoints/content/presentation/initialStyling';
import { unregisterQuickToggle } from '@/entrypoints/content/presentation/quickToggle';
import { clearWholeBlur } from '@/entrypoints/content/video/session/presentationAdapter';
import { resolveVideoSource, type ResolvedVideoSource } from '@/entrypoints/content/video/session/videoSource';

import type { ForcedVisibility, IHostSettings } from '@/utils/types';

/**
 * A user's forced visibility for one (element × source) pair. Session-scoped by
 * design: nothing is persisted, and a changed source drops the override — a
 * different video deserves a fresh verdict.
 */
interface ForcedEntry {
  srcObject: HTMLVideoElement['srcObject'];
  url: string;
  state: Exclude<ForcedVisibility, 'auto'>;
  unprocessed: boolean;
}

function matchesForcedSource(entry: ForcedEntry, source: ResolvedVideoSource): boolean {
  return source.srcObject ? entry.srcObject === source.srcObject : entry.srcObject === null && entry.url === source.url;
}

export interface ForcedPresentationPorts {
  attach: (video: HTMLVideoElement, hostSettings: IHostSettings) => void;
  disposeSession: (video: HTMLVideoElement) => void;
  registerToggle: (
    video: HTMLVideoElement,
    hostSettings: IHostSettings,
    forcedVisibility: ForcedVisibility,
    hasDetections: boolean,
    unprocessed: boolean,
  ) => void;
}

export class ForcedPresentation {
  private readonly overrideByVideo = new WeakMap<HTMLVideoElement, ForcedEntry>();
  private readonly teardownByVideo = new Map<HTMLVideoElement, () => void>();

  constructor(private readonly ports: ForcedPresentationPorts) {}

  reconcile(video: HTMLVideoElement, source: ResolvedVideoSource, hostSettings: IHostSettings): boolean {
    const entry = this.overrideByVideo.get(video);
    if (!entry) return false;
    if (matchesForcedSource(entry, source)) {
      this.apply(video, hostSettings, entry);
      return true;
    }
    this.overrideByVideo.delete(video);
    this.teardownByVideo.get(video)?.();
    return false;
  }

  setOverride(video: HTMLVideoElement, source: ResolvedVideoSource, state: Exclude<ForcedVisibility, 'auto'>): void {
    const unprocessed = this.overrideByVideo.get(video)?.unprocessed ?? video.hasAttribute(PROCESSED_ATTR_MAP.skipped);
    this.overrideByVideo.set(video, { srcObject: source.srcObject, url: source.url, state, unprocessed });
  }

  clearOverride(video: HTMLVideoElement): void {
    this.overrideByVideo.delete(video);
    this.teardownByVideo.get(video)?.();
  }

  release(video: HTMLVideoElement): void {
    this.teardownByVideo.get(video)?.();
  }

  releaseAll(): void {
    for (const teardown of [...this.teardownByVideo.values()]) {
      teardown();
    }
  }

  sweepDisconnected(): void {
    for (const [video, teardown] of [...this.teardownByVideo]) {
      if (!video.isConnected) {
        teardown();
      }
    }
  }

  /**
   * The extension goes hands-off ('visible') or applies the blacklist-style
   * mask ('blocked') with no VideoSession behind it. A source-change listener
   * is the only machinery left running: the override describes this source
   * only, so a new source re-enters normal attachment.
   */
  private apply(video: HTMLVideoElement, hostSettings: IHostSettings, entry: ForcedEntry): void {
    this.ports.disposeSession(video);
    this.teardownByVideo.get(video)?.();

    clearWholeBlur(video);
    resetImageStyling(video);
    if (entry.state === 'blocked') {
      applyBlacklistStyling(video, hostSettings);
      video.setAttribute(PROCESSED_ATTR_MAP.unsafe, '');
    } else {
      video.setAttribute(PROCESSED_ATTR_MAP.skipped, '');
    }
    this.ports.registerToggle(video, hostSettings, entry.state, entry.state === 'blocked', entry.unprocessed);

    const onSourceChanged = () => {
      const current = resolveVideoSource(video);
      // A same-source reload passes through a transient no-source moment
      // ('emptied' before re-selection). Not a source change yet: keep the
      // override and let the loadstart that resolves a source decide.
      if (!current) return;
      const entryNow = this.overrideByVideo.get(video);
      if (entryNow && matchesForcedSource(entryNow, current)) return;
      this.overrideByVideo.delete(video);
      this.teardownByVideo.get(video)?.();
      this.ports.attach(video, hostSettings);
    };
    video.addEventListener('loadstart', onSourceChanged);
    video.addEventListener('emptied', onSourceChanged);
    this.teardownByVideo.set(video, () => {
      this.teardownByVideo.delete(video);
      video.removeEventListener('loadstart', onSourceChanged);
      video.removeEventListener('emptied', onSourceChanged);
      unregisterQuickToggle(video);
      resetImageStyling(video);
    });
  }
}
