import { onInferencePredictions } from '@/entrypoints/content/communication/listener';
import { DomObserver } from '@/entrypoints/content/core/DomObserver';
import { handleImages, handleImageAttributeChange } from '@/entrypoints/content/handlers/handleImages';
import { handleMediaRemoved } from '@/entrypoints/content/handlers/handleMediaRemoved';
import { applyPredictionsToDom } from '@/entrypoints/content/handlers/handlePredictions';
import { isHandled, markHandled } from '@/entrypoints/content/handlers/status';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

/**
 * MediaPipeline handles image detection, inference requests, and prediction application.
 */
export class MediaPipeline {
  private readonly dom: DomObserver;
  private unsubscribeFns: Array<() => void> = [];
  // Cache predictions per src so we can avoid re-sending
  private imagePredictionsCache = new Map<string, IImagePrediction>();
  // helper to pass into image handler functions
  private readonly hasCachedPrediction = (src: string): boolean => this.imagePredictionsCache.has(src);

  constructor(private readonly opts: { hostSettings: IHostSettings }) {
    this.dom = new DomObserver({
      onMediaAdded: (images, videos) => this.onMediaAdded(images, videos),
      onMediaRemoved: elements => handleMediaRemoved(elements),
      onAttributesChanged: elements => this.onAttributesChanged(elements),
    });
  }

  seedCachedPredictions(preds: IImagePrediction[]): void {
    // Seed local cache and try to apply immediately to any matching DOM elements
    preds.forEach(p => this.imagePredictionsCache.set(p.src, p));
    void applyPredictionsToDom(preds, this.opts.hostSettings);
  }

  start(root: Node = document.body): () => void {
    const unsubPreds = onInferencePredictions(data => this.onPredictions(data.predictions));
    this.unsubscribeFns.push(unsubPreds);

    this.dom.start(root);

    return () => this.stop();
  }

  stop(): void {
    this.dom.stop();
    this.unsubscribeFns.forEach(fn => fn());
    this.unsubscribeFns = [];
  }

  private onMediaAdded(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    if (images.length) {
      handleImages(images, { hostSettings: this.opts.hostSettings, hasCachedPrediction: this.hasCachedPrediction });
      // Apply any cached predictions for newly seen images without resending.
      const predsToApply = images
        .map(img => this.imagePredictionsCache.get(img.currentSrc || img.src))
        .filter(Boolean) as IImagePrediction[];
      if (predsToApply.length) void applyPredictionsToDom(predsToApply, this.opts.hostSettings);
    }
    if (videos.length) this.handleVideos(videos);
  }

  private onAttributesChanged(elements: HTMLElement[]): void {
    for (const el of elements) {
      const tag = el.tagName;
      if (tag === 'IMG') {
        const img = el as HTMLImageElement;

        handleImageAttributeChange(img, {
          hostSettings: this.opts.hostSettings,
          hasCachedPrediction: this.hasCachedPrediction,
        });

        // Apply cached predictions if available (debouncing now handled by DomObserver)
        const currentSrc = img.currentSrc || img.src;
        const cached = currentSrc ? this.imagePredictionsCache.get(currentSrc) : undefined;

        if (cached) {
          void applyPredictionsToDom([cached], this.opts.hostSettings);
        }
      } else if (tag === 'VIDEO') {
        this.handleVideos([el as HTMLVideoElement]);
      }
    }
  }

  private handleVideos(videos: HTMLVideoElement[]): void {
    for (const video of videos) {
      const src = video.currentSrc || video.src;
      if (!src) continue;
      if (!isHandled(video, src)) {
        markHandled(video, src);
        // TODO: handle video frames for inference
      }
    }
  }

  // Called when predictions are received from the background script
  private onPredictions(preds: IImagePrediction[]): void {
    if (!preds || preds.length === 0) return;
    // Update cache and apply styles
    preds.forEach(p => this.imagePredictionsCache.set(p.src, p));
    void applyPredictionsToDom(preds, this.opts.hostSettings);
  }
}
