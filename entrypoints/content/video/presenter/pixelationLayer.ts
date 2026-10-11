import { buildCanvasTintFilter, calculatePixelationBlockSize } from '@/utils/masking';

import type { ContentRect } from '@/entrypoints/content/presentation/imageLayout';
import type { IMaskingSettings } from '@/utils/types';

const CANVAS_STYLE =
  'position:absolute;pointer-events:none;image-rendering:pixelated;image-rendering:crisp-edges;display:none;';

export class PixelationLayer {
  readonly canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D | null | undefined;
  private paintedKey = '';
  private styledKey = '';
  private presentedFrames = 0;
  private frameCallbackId: number | null = null;

  constructor(private readonly video: HTMLVideoElement) {
    this.canvas.style.cssText = CANVAS_STYLE;
  }

  paint(content: ContentRect, masking: IMaskingSettings): boolean {
    const { video } = this;
    const context = this.resolveContext();
    if (!context || !hasCurrentFrame(video) || content.width <= 0 || content.height <= 0) {
      this.hide();
      return false;
    }
    this.watchPresentedFrames();
    const blockSize = calculatePixelationBlockSize(masking.pixelationScale);
    const blocksWide = Math.max(1, Math.floor(content.width / blockSize));
    const blocksHigh = Math.max(1, Math.floor(content.height / blockSize));
    this.applyStyle(content, buildCanvasTintFilter(masking));
    const key = [this.frameKey(), blocksWide, blocksHigh].join('|');
    if (key === this.paintedKey) return true;
    this.paintedKey = key;
    const { canvas } = this;
    if (canvas.width !== blocksWide) canvas.width = blocksWide;
    if (canvas.height !== blocksHigh) canvas.height = blocksHigh;
    context.imageSmoothingEnabled = true;
    context.drawImage(video, 0, 0, blocksWide, blocksHigh);
    return true;
  }

  hide(): void {
    if (this.styledKey !== 'hidden') this.canvas.style.display = 'none';
    this.styledKey = 'hidden';
    this.paintedKey = '';
    this.unwatchPresentedFrames();
  }

  private applyStyle(content: ContentRect, filter: string): void {
    const key = [content.offsetX, content.offsetY, content.width, content.height, filter].join('|');
    if (key === this.styledKey) return;
    this.styledKey = key;
    const { style } = this.canvas;
    style.left = `${content.offsetX}px`;
    style.top = `${content.offsetY}px`;
    style.width = `${content.width}px`;
    style.height = `${content.height}px`;
    style.filter = filter;
    style.display = 'block';
  }

  private frameKey(): number {
    if (this.frameCallbackId !== null) return this.presentedFrames;
    return this.video.currentTime;
  }

  private watchPresentedFrames(): void {
    if (this.frameCallbackId !== null || !('requestVideoFrameCallback' in this.video)) return;
    const onPresentedFrame = () => {
      this.presentedFrames++;
      this.frameCallbackId = this.video.requestVideoFrameCallback(onPresentedFrame);
    };
    this.frameCallbackId = this.video.requestVideoFrameCallback(onPresentedFrame);
  }

  private unwatchPresentedFrames(): void {
    if (this.frameCallbackId === null) return;
    this.video.cancelVideoFrameCallback(this.frameCallbackId);
    this.frameCallbackId = null;
  }

  private resolveContext(): CanvasRenderingContext2D | null {
    if (this.context === undefined) this.context = this.canvas.getContext('2d');
    return this.context;
  }
}

const hasCurrentFrame = (video: HTMLVideoElement): boolean =>
  video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
