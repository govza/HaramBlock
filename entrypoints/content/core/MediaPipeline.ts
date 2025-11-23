import { onImagePredictions } from '@/entrypoints/content/communication/listener';
import { DomObserver } from '@/entrypoints/content/core/DomObserver';
import { isHandled, markHandled } from '@/entrypoints/content/core/status';
import { handleImages, handleImageAttributeChange } from '@/entrypoints/content/handlers/handleImages';
import { handleMediaRemoved } from '@/entrypoints/content/handlers/handleMediaRemoved';
import { applyImagePredictionsToDom } from '@/entrypoints/content/presentation/imagePredictions';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

/**
 * MediaPipeline handles image detection, inference requests, and prediction application.
 */
export class MediaPipeline {
  private readonly dom: DomObserver;
  private unsubscribeFns: Array<() => void> = [];
  // Cache predictions per src so we can avoid re-sending
  private imagePredictionsCache = new Map<string, IImagePrediction>();

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
    void applyImagePredictionsToDom(preds, this.opts.hostSettings);
  }

  start(root: Node = document.body): () => void {
    // Filter predictions by hostname - prevents cross-tab pollution when multiple tabs are open
    const unsubImagePreds = onImagePredictions(data => {
      if (data.hostname === this.opts.hostSettings.hostname) {
        this.onImagePredictions(data.predictions);
      }
    });
    this.unsubscribeFns.push(unsubImagePreds);

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
      handleImages(images, this.opts.hostSettings);
    }
    if (videos.length) this.handleVideos(videos);
  }

  private onAttributesChanged(elements: HTMLElement[]): void {
    for (const el of elements) {
      const tag = el.tagName;
      if (tag === 'IMG') {
        const img = el as HTMLImageElement;

        // Apply cached predictions if available
        const cachedPredsToApply = this.imagePredictionsCache.get(img.currentSrc || img.src);
        if (cachedPredsToApply) {
          void applyImagePredictionsToDom([cachedPredsToApply], this.opts.hostSettings, [img]);
        } else {
          handleImageAttributeChange(img, this.opts.hostSettings);
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

  // Called when image predictions are received from the background script
  private onImagePredictions(preds: IImagePrediction[]): void {
    if (!preds || preds.length === 0) return;
    // Update cache and apply styles
    preds.forEach(p => this.imagePredictionsCache.set(p.src, p));
    void applyImagePredictionsToDom(preds, this.opts.hostSettings);
  }
}
