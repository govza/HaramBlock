import { onInferencePredictions } from '@/entrypoints/content/communication/listener';
import { queueImagesForInference } from '@/entrypoints/content/communication/sender';
import { DomObserver } from '@/entrypoints/content/core/DomObserver';
import { MediaStore } from '@/entrypoints/content/core/MediaStore';
import { applyInitialImageStyling, removeInitialImageStyling } from '@/entrypoints/content/presentation/initialStyling';
import { applyPredictionsStyling } from '@/entrypoints/content/presentation/predictionStyling';
import { defaultHostSettings } from '@/utils/db/constants';
import { logger } from '@/utils/logger';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

export class MediaPipeline {
  private readonly dom: DomObserver;
  private readonly store: MediaStore;
  private unsubscribeFns: Array<() => void> = [];

  constructor(private readonly opts: { hostSettings: IHostSettings }) {
    this.dom = new DomObserver({
      onMediaAdded: (images, videos) => this.onMediaAdded(images, videos),
      onMediaRemoved: elements => this.onMediaRemoved(elements),
      onAttributesChanged: elements => this.onAttributesChanged(elements),
    });
    this.store = new MediaStore();
  }

  seedCachedPredictions(preds: IImagePrediction[]): void {
    this.store.seedPredictions(preds);
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
    this.store.clear();
  }

  private onMediaAdded(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    if (this.opts.hostSettings.policy === 'whitelist') return;

    if (images.length) this.handleImages(images);
    if (videos.length) this.handleVideos(videos);
  }

  private onAttributesChanged(elements: HTMLElement[]): void {
    for (const el of elements) {
      const tag = el.tagName;
      if (tag === 'IMG') {
        const img = el as HTMLImageElement;
        this.handleImages([img]);
      } else if (tag === 'VIDEO') {
        this.handleVideos([el as HTMLVideoElement]);
      }
    }
  }

  private onMediaRemoved(elements: HTMLElement[]): void {
    for (const node of elements) {
      if (node.tagName === 'IMG') {
        const img = node as HTMLImageElement;
        const src = img.currentSrc || img.src;
        if (src) this.store.removeElementBySource(src, img);
      } else if (node.tagName === 'VIDEO') {
        const vid = node as HTMLVideoElement;
        const src = vid.currentSrc || vid.src;
        if (src) this.store.removeElementBySource(src, vid);
      }
    }
  }

  private handleImages(images: HTMLImageElement[]): void {
    for (const image of images) {
      const src = image.currentSrc || image.src;
      if (!src) return;
      if (!this.store.isHandled(image, src)) {
        applyInitialImageStyling(image, this.opts.hostSettings);
        this.store.markHandled(image, src);
        this.queueForInference(image);
      }
    }
  }

  private handleVideos(videos: HTMLVideoElement[]): void {
    for (const video of videos) {
      const src = video.currentSrc || video.src;
      if (!src) return;
      if (!this.store.isHandled(video, src)) {
        this.store.markHandled(video, src);
        // TODO: handle video frames for inference
      }
    }
  }

  private queueForInference(image: HTMLImageElement): void {
    const trySendForInference = async () => {
      const src = image.currentSrc || image.src;
      if (!src || this.store.isSentForInference(src)) return;

      const minW = this.opts.hostSettings.minSize?.width ?? defaultHostSettings.minSize.width;
      const minH = this.opts.hostSettings.minSize?.height ?? defaultHostSettings.minSize.height;
      if (image.width < minW || image.height < minH) {
        this.store.markProcessed(src);
        return;
      }

      await queueImagesForInference(this.opts.hostSettings.hostname, [{ src }]);
      this.store.markSentForInference(src);
      logger.withTag('pipeline').debug(`Sent image ${src} for inference`);
    };

    if (image.complete && image.naturalWidth > 0) {
      void trySendForInference();
      return;
    }

    const onLoad = () => {
      void trySendForInference();
    };
    image.addEventListener('load', onLoad, { once: true });
  }

  // Called when predictions are received from the background script
  private onPredictions(preds: IImagePrediction[]): void {
    if (!preds || preds.length === 0) return;
    this.store.upsertPredictions(preds);
    void this.applyPredictionsToDom(preds);
  }

  private async applyPredictionsToDom(preds: IImagePrediction[]): Promise<void> {
    const processPrediction = async (pred: IImagePrediction): Promise<void> => {
      let images = this.store.getImagesBySource(pred.src);

      // If no images found in store, fallback to DOM search (handles lazy loading src changes)
      if (!images.length) {
        images = this.findImagesBySourceInDom(pred.src);
        logger
          .withTag('pipeline')
          .debug(`Store lookup failed for ${pred.src}, found ${images.length} images via DOM fallback`);

        for (const image of images) {
          this.store.markHandled(image, pred.src);
        }
      }

      if (!images.length) {
        logger.withTag('pipeline').debug(`No images found for prediction src: ${pred.src}`);
        return;
      }

      await applyPredictionsStyling(images, [pred], this.opts.hostSettings);
      this.store.markProcessed(pred.src);
      for (const image of images) {
        removeInitialImageStyling(image);
      }
    };

    await Promise.all(preds.map(processPrediction));
  }

  private findImagesBySourceInDom(src: string): HTMLImageElement[] {
    const images: HTMLImageElement[] = [];
    const allImages = document.querySelectorAll('img');

    for (const img of allImages) {
      const imgSrc = img.currentSrc || img.src;
      if (imgSrc === src) {
        images.push(img);
      }
    }

    return images;
  }
}
