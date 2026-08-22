import {
  onImagePredictions,
  onFramePredictions,
  onGifFramePredictions,
  onContextMenuToggle,
} from '@/entrypoints/content/communication/listener';
import { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';
import { DomObserver, type DomObserverConfig } from '@/entrypoints/content/core/DomObserver';
import { ImageProcessor } from '@/entrypoints/content/core/ImageProcessor';
import { routesVideos, runsVideoInference } from '@/entrypoints/content/core/mediaRouting';
import {
  handleVideos,
  handleVideoAttributeChange,
  disposeVideoSession,
} from '@/entrypoints/content/handlers/handleVideos';
import { videoSessions } from '@/entrypoints/content/video/session/registry';

import type { FrameInferenceResult, IHostSettings, IImagePrediction } from '@/utils/types';

export interface MediaPipelineOptions {
  hostSettings: IHostSettings;
  videoProcessingAvailable: boolean;
}

export interface MediaPipelineDeps {
  badgeCounter: BadgeCounter;
  imageProcessor: ImageProcessor;
  createDomObserver: (config: DomObserverConfig) => DomObserver;
  video: {
    handleVideos: typeof handleVideos;
    handleAttributeChange: typeof handleVideoAttributeChange;
    disposeSession: typeof disposeVideoSession;
    sessions: Pick<typeof videoSessions, 'disposeAll' | 'handleResults'>;
  };
}

const productionDeps = (opts: MediaPipelineOptions): MediaPipelineDeps => {
  const badgeCounter = new BadgeCounter();
  return {
    badgeCounter,
    imageProcessor: new ImageProcessor(opts.hostSettings, badgeCounter),
    createDomObserver: config => new DomObserver(config),
    video: {
      handleVideos,
      handleAttributeChange: handleVideoAttributeChange,
      disposeSession: disposeVideoSession,
      sessions: videoSessions,
    },
  };
};

const VERDICT_RECONCILE_DELAY_MS = 100;

export class MediaPipeline {
  private readonly dom: DomObserver;
  private unsubscribeFns: Array<() => void> = [];
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: MediaPipelineOptions,
    private readonly deps: MediaPipelineDeps = productionDeps(opts),
  ) {
    this.dom = deps.createDomObserver({
      onMediaObserved: (images, videos) => this.onMediaObserved(images, videos),
      onMediaRemoved: (images, videos) => this.onMediaRemoved(images, videos),
      onAttributesChanged: (images, videos) => this.onAttributesChanged(images, videos),
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
    this.deps.imageProcessor.seedCache(preds);
  }

  start(root: Node = document.body): () => void {
    const unsubImagePreds = onImagePredictions(data => {
      if (data.hostname === this.opts.hostSettings.hostname) {
        this.deps.imageProcessor.handleInferenceResults(data.results);

        this.scheduleReconciliation();
      }
    });

    this.unsubscribeFns.push(unsubImagePreds);

    const unsubGifPreds = onGifFramePredictions(data => {
      if (data.hostname === this.opts.hostSettings.hostname) {
        this.deps.imageProcessor.handleGifFrameResults(data.results);
        this.scheduleReconciliation();
      }
    });
    this.unsubscribeFns.push(unsubGifPreds);

    if (this.shouldRunVideoInference) {
      const unsubFramePreds = onFramePredictions(data => {
        if (data.hostname === this.opts.hostSettings.hostname) {
          this.handleFrameResults(data.results);
        }
      });
      this.unsubscribeFns.push(unsubFramePreds);
    }

    const unsubToggle = onContextMenuToggle(({ src, forcedVisibility }) => {
      this.deps.imageProcessor.toggleImage(src, forcedVisibility);
    });
    this.unsubscribeFns.push(unsubToggle);

    this.dom.start(root);

    return () => this.stop();
  }

  private scheduleReconciliation(): void {
    this.reconcileTimer ??= setTimeout(() => {
      this.reconcileTimer = null;
      this.dom.markAllDirty();
    }, VERDICT_RECONCILE_DELAY_MS);
  }

  stop(): void {
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.dom.stop();
    this.deps.imageProcessor.dispose();
    this.deps.badgeCounter.dispose();
    this.deps.video.sessions.disposeAll();
    this.unsubscribeFns.forEach(fn => fn());
    this.unsubscribeFns = [];
  }

  private onMediaObserved(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    if (this.shouldProcessImages || this.shouldProcessGif) {
      this.deps.imageProcessor.processAll(images);
    }
    if (videos.length && this.shouldProcessVideo) {
      this.deps.video.handleVideos(videos, this.opts.hostSettings);
    }
  }

  private onMediaRemoved(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    for (const img of images) {
      this.deps.imageProcessor.handleRemoved(img);
    }
    for (const video of videos) {
      this.deps.video.disposeSession(video);
    }
  }

  private onAttributesChanged(images: HTMLImageElement[], videos: HTMLVideoElement[]): void {
    if (this.shouldProcessImages || this.shouldProcessGif) {
      for (const img of images) {
        this.deps.imageProcessor.handleSrcChange(img);
      }
    }
    if (this.shouldProcessVideo) {
      for (const video of videos) {
        this.deps.video.handleAttributeChange(video, this.opts.hostSettings);
      }
    }
  }

  private handleFrameResults(results: FrameInferenceResult[]): void {
    if (!results || results.length === 0) return;
    this.deps.video.sessions.handleResults(results);
  }
}
