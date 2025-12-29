import { onImagePredictions, onFramePredictions } from '@/entrypoints/content/communication/listener';
import { DomObserver } from '@/entrypoints/content/core/DomObserver';
import { ImageProcessor } from '@/entrypoints/content/core/ImageProcessor';
import {
  handleVideos,
  handleVideoAttributeChange,
  disposeVideoSession,
} from '@/entrypoints/content/handlers/handleVideos';
import { applyFramePredictionsToDom } from '@/entrypoints/content/presentation/videoPredictions';

import type { IHostSettings, IImagePrediction, IFramePrediction } from '@/utils/types';

export class MediaPipeline {
  private readonly dom: DomObserver;
  private readonly imageProcessor: ImageProcessor;
  private unsubscribeFns: Array<() => void> = [];

  constructor(private readonly opts: { hostSettings: IHostSettings }) {
    this.imageProcessor = new ImageProcessor(opts.hostSettings);

    this.dom = new DomObserver({
      onMediaAdded: (images, videos) => this.onMediaAdded(images, videos),
      onMediaRemoved: elements => this.onMediaRemoved(elements),
      onAttributesChanged: elements => this.onAttributesChanged(elements),
    });
  }

  seedCachedPredictions(preds: IImagePrediction[]): void {
    this.imageProcessor.seedCache(preds);
  }

  start(root: Node = document.body): () => void {
    const unsubImagePreds = onImagePredictions(data => {
      if (data.hostname === this.opts.hostSettings.hostname) {
        this.imageProcessor.handlePredictions(data.predictions);
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
    this.imageProcessor.dispose();
    this.unsubscribeFns.forEach(fn => fn());
    this.unsubscribeFns = [];
  }

  private onMediaAdded(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    this.imageProcessor.processAll(images);
    if (videos.length) {
      handleVideos(videos, this.opts.hostSettings);
    }
  }

  private onMediaRemoved(elements: HTMLElement[]): void {
    for (const el of elements) {
      if (el.tagName === 'VIDEO') {
        disposeVideoSession(el as HTMLVideoElement);
      } else if (el.tagName === 'IMG') {
        this.imageProcessor.handleRemoved(el as HTMLImageElement);
      }
    }
  }

  private onAttributesChanged(elements: HTMLElement[]): void {
    for (const el of elements) {
      if (el.tagName === 'IMG') {
        this.imageProcessor.handleSrcChange(el as HTMLImageElement);
      } else if (el.tagName === 'VIDEO') {
        handleVideoAttributeChange(el as HTMLVideoElement, this.opts.hostSettings);
      }
    }
  }

  private handleFramePredictions(preds: IFramePrediction[]): void {
    if (!preds || preds.length === 0) return;
    void applyFramePredictionsToDom(preds, this.opts.hostSettings);
  }
}
