import { VIDEO_MASK_OVERLAY_ATTR } from '@/entrypoints/content/presentation/constants';
import { anchorOverlay, type OverlayAnchor } from '@/entrypoints/content/presentation/overlayAnchor';
import { maskClipPath } from '@/entrypoints/content/video/presenter/maskClipPath';
import { PixelationLayer } from '@/entrypoints/content/video/presenter/pixelationLayer';
import { createPresentationClock } from '@/entrypoints/content/video/presenter/presentationClock';
import { isNativeFullscreen, VideoFilterMask } from '@/entrypoints/content/video/presenter/videoFilterMask';
import { buildMaskingFilter } from '@/utils/masking';

import type { ContentRect } from '@/entrypoints/content/presentation/imageLayout';
import type { VerdictForOptions, VerdictInterpreter } from '@/entrypoints/content/video/timeline/verdictInterpreter';
import type { VerdictEntry } from '@/entrypoints/content/video/timeline/verdictTimeline';
import type { IMaskingSettings } from '@/utils/types';

/**
 * What the Mask Presenter needs from its VideoSession: the video it overlays, the Verdict
 * Interpreter it queries each frame, and callbacks reporting what it presented.
 */
export interface MaskPresenterOptions {
  video: HTMLVideoElement;
  interpreter: VerdictInterpreter;
  verdictOptions: () => VerdictForOptions;
  masking: () => IMaskingSettings;
  onPresented(unsafe: boolean): void;
  onFrame(mediaTimeSec: number): void;
}

export class MaskPresenter {
  private readonly clock = createPresentationClock();
  private overlay: HTMLDivElement | null = null;
  private anchor: OverlayAnchor | null = null;
  private rafId: number | null = null;
  private thumbnail: VerdictEntry | null = null;
  private playbackStarted: boolean;
  private shownEntries: readonly VerdictEntry[] | null = null;
  private clippedContent: ContentRect | null = null;
  private filter = '';
  private presentedUnsafe: boolean | null = null;
  private readonly videoFilterMask: VideoFilterMask;
  private readonly pixelation: PixelationLayer;

  constructor(private readonly options: MaskPresenterOptions) {
    this.videoFilterMask = new VideoFilterMask(options.video);
    this.pixelation = new PixelationLayer(options.video);
    this.playbackStarted = !options.video.paused || options.video.played.length > 0;
    options.video.addEventListener('playing', this.onPlaying);
  }

  private readonly onPlaying = () => {
    this.playbackStarted = true;
  };

  setThumbnail(entry: VerdictEntry | null): void {
    this.thumbnail = entry;
  }

  start(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.present();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.hide();
  }

  dispose(): void {
    this.stop();
    this.options.video.removeEventListener('playing', this.onPlaying);
    this.anchor?.dispose();
    this.anchor = null;
    this.overlay?.remove();
    this.overlay = null;
  }

  isMasking(): boolean {
    return this.shownEntries !== null;
  }

  private present(): void {
    const { video, interpreter, verdictOptions } = this.options;
    const mediaTime = this.clock.timeAt(video, performance.now());
    this.options.onFrame(mediaTime);
    const lookup = interpreter.verdictFor(mediaTime, verdictOptions());
    if (lookup.kind === 'unsafe') {
      this.reportPresented(true);
      this.show(lookup.entries);
      return;
    }
    if (lookup.kind === 'clean') this.reportPresented(false);
    if (this.thumbnail && !this.playbackStarted) {
      this.show([this.thumbnail]);
      return;
    }
    this.hide();
  }

  private reportPresented(unsafe: boolean): void {
    if (this.presentedUnsafe === unsafe) return;
    this.presentedUnsafe = unsafe;
    this.options.onPresented(unsafe);
  }

  private show(entries: readonly VerdictEntry[]): void {
    const { video } = this.options;
    if (isNativeFullscreen(video)) {
      this.showAsVideoFilter(entries);
      return;
    }
    this.videoFilterMask.clear();
    const overlay = this.ensureOverlay();
    this.anchor ??= anchorOverlay(video, overlay, {
      onLost: () => {
        this.anchor = null;
      },
    });
    const geometry = this.anchor.refresh();
    if (!geometry) return;
    if (!sameContent(geometry.content, this.clippedContent) || !sameEntries(entries, this.shownEntries)) {
      const path = maskClipPath(entries, geometry.content);
      overlay.style.clipPath = path ? `path('${path}')` : 'inset(0)';
      this.clippedContent = geometry.content;
    }
    const masking = this.options.masking();
    const pixelated = this.pixelation.paint(geometry.content, masking);
    const filter = pixelated ? '' : buildMaskingFilter(masking);
    if (filter !== this.filter) {
      this.filter = filter;
      overlay.style.setProperty('backdrop-filter', filter);
      overlay.style.setProperty('-webkit-backdrop-filter', filter);
    }
    overlay.style.display = 'block';
    this.shownEntries = entries;
  }

  private showAsVideoFilter(entries: readonly VerdictEntry[]): void {
    this.hideOverlay();
    this.videoFilterMask.apply(buildMaskingFilter(this.options.masking()));
    this.shownEntries = entries;
  }

  private hide(): void {
    this.hideOverlay();
    this.videoFilterMask.clear();
    this.shownEntries = null;
  }

  private hideOverlay(): void {
    if (this.overlay) this.overlay.style.display = 'none';
    this.pixelation.hide();
  }

  private ensureOverlay(): HTMLDivElement {
    if (this.overlay) return this.overlay;
    const overlay = document.createElement('div');
    overlay.setAttribute(VIDEO_MASK_OVERLAY_ATTR, 'video-mask-presenter');
    overlay.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;display:none;';
    overlay.appendChild(this.pixelation.canvas);
    this.overlay = overlay;
    return overlay;
  }
}

function sameEntries(a: readonly VerdictEntry[], b: readonly VerdictEntry[] | null): boolean {
  return b !== null && a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function sameContent(a: ContentRect, b: ContentRect | null): boolean {
  return (
    b !== null && a.offsetX === b.offsetX && a.offsetY === b.offsetY && a.width === b.width && a.height === b.height
  );
}
