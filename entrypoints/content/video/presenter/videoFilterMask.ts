import { BLUR_CLASS } from '@/entrypoints/content/presentation/constants';

/**
 * The page's own inline `filter` declaration, saved before the fullscreen mask overrides it and
 * restored on clear.
 */
interface SavedFilter {
  value: string;
  priority: string;
}

export function isNativeFullscreen(video: HTMLVideoElement): boolean {
  const root = video.getRootNode() as Document | ShadowRoot;
  return root.fullscreenElement === video;
}

export class VideoFilterMask {
  private saved: SavedFilter | null = null;

  constructor(private readonly video: HTMLVideoElement) {}

  apply(filter: string): void {
    if (this.video.classList.contains(BLUR_CLASS)) return;
    const { style } = this.video;
    this.saved ??= { value: style.getPropertyValue('filter'), priority: style.getPropertyPriority('filter') };
    style.setProperty('filter', filter, 'important');
  }

  clear(): void {
    if (!this.saved) return;
    const { style } = this.video;
    if (this.saved.value) style.setProperty('filter', this.saved.value, this.saved.priority);
    else style.removeProperty('filter');
    this.saved = null;
  }
}
