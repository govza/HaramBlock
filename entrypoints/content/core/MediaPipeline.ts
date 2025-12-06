import { onImagePredictions, onFramePredictions } from '@/entrypoints/content/communication/listener';
import { DomObserver } from '@/entrypoints/content/core/DomObserver';
import { handleImages, handleImageAttributeChange } from '@/entrypoints/content/handlers/handleImages';
import { handleMediaRemoved } from '@/entrypoints/content/handlers/handleMediaRemoved';
import {
  handleVideos,
  handleVideoAttributeChange,
  disposeVideoSession,
} from '@/entrypoints/content/handlers/handleVideos';
import { applyImagePredictionsToDom } from '@/entrypoints/content/presentation/imagePredictions';
import { applyFramePredictionsToDom } from '@/entrypoints/content/presentation/videoPredictions';

import type { IHostSettings, IImagePrediction, IFramePrediction } from '@/utils/types';

export class MediaPipeline {
  private readonly dom: DomObserver;
  private unsubscribeFns: Array<() => void> = [];
  // Cache predictions per src so we can avoid re-sending
  private imagePredictionsCache = new Map<string, IImagePrediction>();

  constructor(private readonly opts: { hostSettings: IHostSettings }) {
    this.dom = new DomObserver({
      onMediaAdded: (images, videos) => this.onMediaAdded(images, videos),
      onMediaRemoved: elements => this.onMediaRemoved(elements),
      onAttributesChanged: elements => this.onAttributesChanged(elements),
    });
  }

  seedCachedPredictions(preds: IImagePrediction[]): void {
    // Seed local cache and try to apply immediately to any matching DOM elements
    preds.forEach(p => this.imagePredictionsCache.set(p.src, p));
    void applyImagePredictionsToDom(preds, this.opts.hostSettings);
  }

  start(root: Node = document.body): () => void {
    const unsubImagePreds = onImagePredictions(data => {
      if (data.hostname === this.opts.hostSettings.hostname) {
        this.handleImagePredictions(data.predictions);
      }
    });

    const unsubFramePreds = onFramePredictions(data => {
      if (data.hostname === this.opts.hostSettings.hostname) {
        this.handleFramePredictions(data.predictions);
      }
    });

    this.unsubscribeFns.push(unsubImagePreds, unsubFramePreds);
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
    if (videos.length) {
      handleVideos(videos, this.opts.hostSettings);
    }
  }

  private onMediaRemoved(elements: HTMLElement[]): void {
    // Clean up video sessions for removed videos
    for (const el of elements) {
      if (el.tagName === 'VIDEO') {
        disposeVideoSession(el as HTMLVideoElement);
      }
    }
    handleMediaRemoved(elements);
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
        handleVideoAttributeChange(el as HTMLVideoElement, this.opts.hostSettings);
      }
    }
  }

  private handleImagePredictions(preds: IImagePrediction[]): void {
    if (!preds || preds.length === 0) return;
    preds.forEach(p => this.imagePredictionsCache.set(p.src, p));
    void applyImagePredictionsToDom(preds, this.opts.hostSettings);
  }

  private handleFramePredictions(preds: IFramePrediction[]): void {
    if (!preds || preds.length === 0) return;
    void applyFramePredictionsToDom(preds, this.opts.hostSettings);
  }
}
