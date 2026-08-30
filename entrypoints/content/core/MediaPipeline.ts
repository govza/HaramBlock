import {
  onImagePredictions,
  onFramePredictions,
  onGifFramePredictions,
  onContextMenuToggle,
} from '@/entrypoints/content/communication/listener';
import { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';
import { DomObserver } from '@/entrypoints/content/core/DomObserver';
import { ImageProcessor } from '@/entrypoints/content/core/ImageProcessor';
import { routesVideos, runsVideoInference } from '@/entrypoints/content/core/mediaRouting';
import { VideoProcessor } from '@/entrypoints/content/core/VideoProcessor';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

export class MediaPipeline {
  private readonly dom: DomObserver;
  private readonly imageProcessor: ImageProcessor;
  private readonly videoProcessor: VideoProcessor;
  private readonly badgeCounter: BadgeCounter;
  private unsubscribeFns: Array<() => void> = [];

  constructor(private readonly opts: { hostSettings: IHostSettings; videoProcessingAvailable: boolean }) {
    this.badgeCounter = new BadgeCounter();
    this.imageProcessor = new ImageProcessor(opts.hostSettings, this.badgeCounter);
    this.videoProcessor = new VideoProcessor(opts.hostSettings);

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

  private get shouldProcessGif(): boolean {
    return this.policy.behavior === 'process' && this.policy.targets.gif;
  }

  private get shouldProcessVideo(): boolean {
    return routesVideos(this.policy, this.opts.videoProcessingAvailable);
  }

  private get shouldRunVideoInference(): boolean {
    return runsVideoInference(this.policy, this.opts.videoProcessingAvailable);
  }

  seedCachedPredictions(preds: IImagePrediction[]): void {
    this.imageProcessor.seedCache(preds);
  }

  start(root: Node = document.body): () => void {
    const unsubImagePreds = onImagePredictions(data => {
      if (data.hostname === this.opts.hostSettings.hostname) {
        this.imageProcessor.handleInferenceResults(data.results);
      }
    });

    this.unsubscribeFns.push(unsubImagePreds);

    // GIF frame verdicts arrive whenever images are being processed.
    const unsubGifPreds = onGifFramePredictions(data => {
      if (data.hostname === this.opts.hostSettings.hostname) {
        this.imageProcessor.handleGifFrameResults(data.results);
      }
    });
    this.unsubscribeFns.push(unsubGifPreds);

    if (this.shouldRunVideoInference) {
      const unsubFramePreds = onFramePredictions(data => {
        if (data.hostname === this.opts.hostSettings.hostname) {
          this.videoProcessor.handleInferenceResults(data.results);
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
    this.videoProcessor.dispose();
    this.unsubscribeFns.forEach(fn => fn());
    this.unsubscribeFns = [];
  }

  private onMediaAdded(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    // GIFs are <img> elements too, so the image processor runs whenever either
    // static images or GIFs are targeted; it routes each element to the right path.
    if (this.shouldProcessImages || this.shouldProcessGif) {
      this.imageProcessor.processAll(images);
    }
    if (videos.length && this.shouldProcessVideo) {
      this.videoProcessor.processAll(videos);
    }
  }

  private onMediaRemoved(elements: HTMLElement[]): void {
    for (const el of elements) {
      // A removal notification for a still-connected element is a re-parent
      // (mutation callbacks are async — a moved node is already re-attached by
      // the time we look), not a removal: YouTube moves its player container
      // during watch-page boot, and disposing here would kill the just-adopted
      // session with nothing left to rediscover it.
      if (el.isConnected) continue;
      if (el.tagName === 'VIDEO') {
        this.videoProcessor.handleRemoved(el as HTMLVideoElement);
      } else if (el.tagName === 'IMG') {
        this.imageProcessor.handleRemoved(el as HTMLImageElement);
      }
    }
  }

  private onAttributesChanged(elements: HTMLElement[]): void {
    for (const el of elements) {
      if (el.tagName === 'IMG') {
        if (this.shouldProcessImages || this.shouldProcessGif) {
          this.imageProcessor.handleSrcChange(el as HTMLImageElement);
        }
      } else if (el.tagName === 'VIDEO' && this.shouldProcessVideo) {
        this.videoProcessor.handleSrcChange(el as HTMLVideoElement);
      }
    }
  }
}
