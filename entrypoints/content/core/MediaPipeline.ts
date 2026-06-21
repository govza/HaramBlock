import {
  onImagePredictions,
  onFramePredictions,
  onContextMenuToggle,
} from '@/entrypoints/content/communication/listener';
import { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';
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
  private readonly badgeCounter: BadgeCounter;
  private unsubscribeFns: Array<() => void> = [];

  constructor(private readonly opts: { hostSettings: IHostSettings }) {
    this.badgeCounter = new BadgeCounter();
    this.imageProcessor = new ImageProcessor(opts.hostSettings, this.badgeCounter);

    this.dom = new DomObserver({
      onMediaAdded: (images, videos) => this.onMediaAdded(images, videos),
      onMediaRemoved: elements => this.onMediaRemoved(elements),
      onAttributesChanged: elements => this.onAttributesChanged(elements),
    });
  }

  private get policy() {
    return this.opts.hostSettings.policy;
  }

  private get shouldProcessImages(): boolean {
    return this.policy.behavior === 'blacklist' || (this.policy.behavior === 'process' && this.policy.targets.image);
  }

  private get shouldProcessVideo(): boolean {
    return this.policy.behavior === 'blacklist' || (this.policy.behavior === 'process' && this.policy.targets.video);
  }

  private get shouldRunVideoInference(): boolean {
    return this.policy.behavior === 'process' && this.policy.targets.video;
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

    this.unsubscribeFns.push(unsubImagePreds);

    if (this.shouldRunVideoInference) {
      const unsubFramePreds = onFramePredictions(data => {
        if (data.hostname === this.opts.hostSettings.hostname) {
          this.handleFramePredictions(data.predictions);
        }
      });
      this.unsubscribeFns.push(unsubFramePreds);
    }

    const unsubToggle = onContextMenuToggle(({ src, forcedVisibility }) => {
      this.imageProcessor.toggleImage(src, forcedVisibility);
    });
    this.unsubscribeFns.push(unsubToggle);

    this.dom.start(root);

    return () => this.stop();
  }

  stop(): void {
    this.dom.stop();
    this.imageProcessor.dispose();
    this.badgeCounter.dispose();
    this.unsubscribeFns.forEach(fn => fn());
    this.unsubscribeFns = [];
  }

  private onMediaAdded(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    if (this.shouldProcessImages) {
      this.imageProcessor.processAll(images);
    }
    if (videos.length && this.shouldProcessVideo) {
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
        if (this.shouldProcessImages) {
          this.imageProcessor.handleSrcChange(el as HTMLImageElement);
        }
      } else if (el.tagName === 'VIDEO' && this.shouldProcessVideo) {
        handleVideoAttributeChange(el as HTMLVideoElement, this.opts.hostSettings);
      }
    }
  }

  private handleFramePredictions(preds: IFramePrediction[]): void {
    if (!preds || preds.length === 0) return;
    void applyFramePredictionsToDom(preds, this.opts.hostSettings);
  }
}
