import { onInferencePredictions } from '@/entrypoints/content/communication/listener';
import { DomObserver } from '@/entrypoints/content/core/DomObserver';
import { handleImages, handleImageAttributeChange } from '@/entrypoints/content/handlers/handleImages';
import { handleMediaRemoved } from '@/entrypoints/content/handlers/handleMediaRemoved';
import { isHandled, markHandled, markProcessed } from '@/entrypoints/content/handlers/status';
import { clearBlurBoxOverlay } from '@/entrypoints/content/presentation/boundingBox';
import { removeInitialImageStyling } from '@/entrypoints/content/presentation/initialStyling';
import { clearMaskOverlay } from '@/entrypoints/content/presentation/maskOverlays';
import { applyPredictionsStyling } from '@/entrypoints/content/presentation/predictionStyling';
import { extractUrlId, logger } from '@/utils/logger';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

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
    if (images.length) {
      handleImages(images, { hostSettings: this.opts.hostSettings, hasCachedPrediction: this.hasCachedPrediction });
      // Apply any cached predictions for newly seen images without resending.
      const predsToApply = images
        .map(img => this.imagePredictionsCache.get(img.currentSrc || img.src))
        .filter(Boolean) as IImagePrediction[];
      if (predsToApply.length) void this.applyPredictionsToDom(predsToApply);
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
        // If the src changed to one we already have predictions for, apply them.
        const src = img.currentSrc || img.src;
        const cached = src ? this.imagePredictionsCache.get(src) : undefined;
        if (cached) void this.applyPredictionsToDom([cached]);
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
    void this.applyPredictionsToDom(preds);
  }

  private async applyPredictionsToDom(preds: IImagePrediction[]): Promise<void> {
    // Deduplicate by src to avoid re-applying overlays multiple times per batch
    const bySrc = new Map<string, IImagePrediction>();
    for (const p of preds) bySrc.set(p.src, p);
    const uniquePreds = Array.from(bySrc.values());

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

      // Wait for images to load before applying styling
      const loadedImages = await Promise.all(
        matchingImages.map(async img => {
          if (img.complete && img.naturalWidth > 0) {
            return img;
          }

          return new Promise<HTMLImageElement>(resolve => {
            const handleLoad = () => {
              img.removeEventListener('load', handleLoad);
              img.removeEventListener('error', handleError);
              resolve(img);
            };

            const handleError = () => {
              img.removeEventListener('load', handleLoad);
              img.removeEventListener('error', handleError);
              logger.withTag('pipeline').debug(`Image failed to load: ${extractUrlId(pred.src)}`);
              resolve(img); // Still resolve to allow cleanup
            };

            img.addEventListener('load', handleLoad);
            img.addEventListener('error', handleError);
          });
        }),
      );

      // If this prediction has no detections, ensure overlays are cleared
      if (!pred.predictions || pred.predictions.length === 0) {
        for (const image of loadedImages) {
          clearMaskOverlay(image);
          clearBlurBoxOverlay(image);
          removeInitialImageStyling(image);
          markProcessed(image, pred.src);
        }
        return;
      }

      // Only apply styling to fully loaded images
      const fullyLoadedImages = loadedImages.filter(img => img.complete && img.naturalWidth > 0);
      if (fullyLoadedImages.length > 0) {
        await applyPredictionsStyling(fullyLoadedImages, [pred], this.opts.hostSettings);
      }

      for (const image of loadedImages) {
        markProcessed(image, pred.src);
        removeInitialImageStyling(image);
      }
    };

    await Promise.all(uniquePreds.map(processPrediction));
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
