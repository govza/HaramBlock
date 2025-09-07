import { onInferencePredictions } from '@/entrypoints/content/communication/listener';
import { requestImageInference } from '@/entrypoints/content/communication/sender';
import { DomObserver } from '@/entrypoints/content/core/DomObserver';
import { clearBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { applyInitialImageStyling, removeInitialImageStyling } from '@/entrypoints/content/presentation/initialStyling';
import { clearMaskOverlay } from '@/entrypoints/content/presentation/maskOverlays';
import { applyPredictionsStyling } from '@/entrypoints/content/presentation/predictionStyling';
import { defaultHostSettings } from '@/utils/db/constants';
import { extractUrlId, logger } from '@/utils/logger';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

export class MediaPipeline {
  private readonly dom: DomObserver;
  private unsubscribeFns: Array<() => void> = [];
  // Cache predictions per src so we can avoid re-sending
  private predictionsCache = new Map<string, IImagePrediction>();

  constructor(private readonly opts: { hostSettings: IHostSettings }) {
    this.dom = new DomObserver({
      onMediaAdded: (images, videos) => this.onMediaAdded(images, videos),
      onMediaRemoved: elements => this.onMediaRemoved(elements),
      onAttributesChanged: elements => this.onAttributesChanged(elements),
    });
  }

  seedCachedPredictions(preds: IImagePrediction[]): void {
    // Seed local cache and try to apply immediately to any matching DOM elements
    preds.forEach(p => this.predictionsCache.set(p.src, p));
    void this.applyPredictionsToDom(preds);
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
    if (this.opts.hostSettings.policy === 'whitelist') return;

    if (images.length) this.handleImages(images);
    if (videos.length) this.handleVideos(videos);
  }

  private onAttributesChanged(elements: HTMLElement[]): void {
    for (const el of elements) {
      const tag = el.tagName;
      if (tag === 'IMG') {
        const img = el as HTMLImageElement;
        // If src changed compared to our tracked dataset, clear overlays from previous src
        const currentSrc = img.currentSrc || img.src;
        if (img.dataset.hbSrc && img.dataset.hbSrc !== currentSrc) {
          clearMaskOverlay(img);
          clearBlurBoxOverlay(img);
          removeInitialImageStyling(img);
          // Clear handled flags so we reprocess new src
          delete img.dataset.hbHandled;
          delete img.dataset.hbSent;
          delete img.dataset.hbProcessed;
          img.dataset.hbSrc = currentSrc;
        }
        this.handleImages([img]);
      } else if (tag === 'VIDEO') {
        this.handleVideos([el as HTMLVideoElement]);
      }
    }
  }

  private onMediaRemoved(elements: HTMLElement[]): void {
    // No-op: state tracking moved to DOM dataset attributes
    void elements;
  }

  private handleImages(images: HTMLImageElement[]): void {
    for (const image of images) {
      const src = image.currentSrc || image.src;
      if (!src) continue;
      if (!this.isHandled(image, src)) {
        applyInitialImageStyling(image, this.opts.hostSettings);
        this.markHandled(image, src);
        this.queueForInference(image);
      }
    }
  }

  private handleVideos(videos: HTMLVideoElement[]): void {
    for (const video of videos) {
      const src = video.currentSrc || video.src;
      if (!src) continue;
      if (!this.isHandled(video, src)) {
        this.markHandled(video, src);
        // TODO: handle video frames for inference
      }
    }
  }

  private queueForInference(image: HTMLImageElement): void {
    const trySendForInference = async () => {
      const src = image.currentSrc || image.src;
      if (!src) return;

      // Check if already sent for inference
      if (this.isSentForInference(image, src)) {
        return;
      }

      // Check for cached predictions first
      const cachedPrediction = this.predictionsCache.get(src);
      if (cachedPrediction) {
        await this.applyPredictionsToDom([cachedPrediction]);
        return;
      }

      const minW = this.opts.hostSettings.minSize?.width ?? defaultHostSettings.minSize.width;
      const minH = this.opts.hostSettings.minSize?.height ?? defaultHostSettings.minSize.height;
      if (image.width < minW || image.height < minH) {
        // Mark as processed to skip future attempts for this src on this element
        this.markProcessed(image, src);
        return;
      }

      try {
        await requestImageInference(this.opts.hostSettings.hostname, image);
        this.markSentForInference(image, src);
        logger.withTag('pipeline').debug(`Sent image ${extractUrlId(src)} for inference`);
      } catch (error) {
        logger.withTag('pipeline').error(`Failed to send image ${extractUrlId(src)} for inference:`, error);
        this.markProcessed(image, src);
      }
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
    // Update cache and apply styles
    preds.forEach(p => this.predictionsCache.set(p.src, p));
    void this.applyPredictionsToDom(preds);
  }

  private async applyPredictionsToDom(preds: IImagePrediction[]): Promise<void> {
    const processPrediction = async (pred: IImagePrediction): Promise<void> => {
      // Main method: find images in DOM by src
      const images = this.findImagesBySourceInDom(pred.src);

      if (!images.length) {
        logger.withTag('pipeline').debug(`No images found for prediction src: ${extractUrlId(pred.src)}`);
        return;
      }

      const matchingImages = images.filter(img => (img.currentSrc || img.src) === pred.src);
      if (!matchingImages.length) {
        logger.withTag('pipeline').debug(`Prediction src changed before styling applied: ${pred.src}`);
        return;
      }

      // If this prediction has no detections, ensure overlays are cleared
      if (!pred.predictions || pred.predictions.length === 0) {
        for (const image of matchingImages) {
          clearMaskOverlay(image);
          clearBlurBoxOverlay(image);
          removeInitialImageStyling(image);
          this.markProcessed(image, pred.src);
        }
        return;
      }

      await applyPredictionsStyling(matchingImages, [pred], this.opts.hostSettings);
      for (const image of matchingImages) {
        this.markProcessed(image, pred.src);
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

  // === DOM dataset state helpers ===
  private isHandled(el: HTMLImageElement | HTMLVideoElement, src: string): boolean {
    // Ensure we only consider current src
    return el.dataset.hbSrc === src && el.dataset.hbHandled === '1';
  }

  private markHandled(el: HTMLImageElement | HTMLVideoElement, src: string): void {
    el.dataset.hbSrc = src;
    el.dataset.hbHandled = '1';
    // Reset per-src flags on new src
    el.dataset.hbSent = '0';
    el.dataset.hbProcessed = '0';
  }

  private markSentForInference(el: HTMLImageElement | HTMLVideoElement, src: string): void {
    if (el.dataset.hbSrc !== src) el.dataset.hbSrc = src;
    el.dataset.hbSent = '1';
  }

  private isSentForInference(el: HTMLImageElement | HTMLVideoElement, src: string): boolean {
    return el.dataset.hbSrc === src && el.dataset.hbSent === '1';
  }

  private markProcessed(el: HTMLImageElement | HTMLVideoElement, src: string): void {
    if (el.dataset.hbSrc !== src) el.dataset.hbSrc = src;
    el.dataset.hbProcessed = '1';
  }
}
