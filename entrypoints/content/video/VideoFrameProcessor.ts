import { captureFrameBitmap } from '@/entrypoints/content/video/frameCapture';
import { logger } from '@/utils/logger';

import type { VideoFrameLoopConfig } from '@/utils/constants/video';

type FrameIntent = { kind: 'thumbnail' } | { kind: 'frame'; frameIndex: number; timestampSec: number };

export class VideoFrameProcessor {
  private readonly maxFps: number;
  private readonly sessionId: string;
  private readonly capacity = 1;
  private rafId: number | null = null;
  private tokens = this.capacity;
  private lastRefill = performance.now();
  private lastInferenceMs = 150;
  private inflightUntil = 0;
  private lastFrameSentAt = 0;
  private errorCount = 0;
  private frameIndex: number;
  private installed = false;
  private disposed = false;

  private readonly handlePlay = () => this.onPlay();
  private readonly handlePause = () => this.onPause();
  private readonly handleEnded = () => this.onPause();
  private readonly handleEmptied = () => this.onEmptied();
  private readonly inferenceTimingListener = (event: Event) => {
    const { detail } = event as CustomEvent<{ inferenceTime?: number }>;
    if (detail?.inferenceTime && Number.isFinite(detail.inferenceTime)) {
      this.lastInferenceMs = Math.max(50, Math.min(1000, detail.inferenceTime));
    }
  };

  constructor(
    private readonly video: HTMLVideoElement,
    private hostname: string,
    private readonly config: VideoFrameLoopConfig,
    private readonly sendSample: (
      video: HTMLVideoElement,
      bitmap: ImageBitmap,
      hostname: string,
      intent: FrameIntent,
      sessionId: string,
    ) => Promise<void>,
  ) {
    this.maxFps = Math.max(1, Math.min(60, config.maxSendFps ?? 7));
    this.frameIndex = parseInt(video.dataset.hbFrameCount || '0') || 0;
    // Get or create sessionId from dataset
    this.sessionId = video.dataset.hbSessionId || crypto.randomUUID();
    video.dataset.hbSessionId = this.sessionId;
  }

  updateHostname(hostname: string): void {
    this.hostname = hostname;
  }

  install(): void {
    if (this.installed || this.disposed) return;
    this.installed = true;
    this.video.addEventListener('play', this.handlePlay);
    this.video.addEventListener('pause', this.handlePause);
    this.video.addEventListener('ended', this.handleEnded);
    this.video.addEventListener('emptied', this.handleEmptied);
    globalThis.window.addEventListener('hb:inference-timing', this.inferenceTimingListener);

    if (!this.video.paused && !this.video.ended && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.prepareForPlayback();
      this.queueNextFrame();
    }
  }

  start(): void {
    if (this.disposed) return;
    this.onPlay();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    if (this.installed) {
      this.video.removeEventListener('play', this.handlePlay);
      this.video.removeEventListener('pause', this.handlePause);
      this.video.removeEventListener('ended', this.handleEnded);
      this.video.removeEventListener('emptied', this.handleEmptied);
      this.installed = false;
    }
    globalThis.window.removeEventListener('hb:inference-timing', this.inferenceTimingListener);
  }

  private onPlay(): void {
    if (this.disposed) return;
    this.prepareForPlayback();
    this.queueNextFrame();
  }

  private onPause(): void {
    this.stopLoop();
  }

  private onEmptied(): void {
    this.stopLoop();
    this.tokens = this.capacity;
    this.lastRefill = performance.now();
    this.inflightUntil = 0;
    this.lastFrameSentAt = 0;
    this.errorCount = 0;
    this.frameIndex = 0;
    this.video.dataset.hbFrameCount = '0';
    delete this.video.dataset.hbVideoStatus;
  }

  private prepareForPlayback(): void {
    this.tokens = this.capacity;
    this.lastRefill = performance.now();
    this.inflightUntil = 0;
    this.lastFrameSentAt = 0;
    this.errorCount = 0;
    this.video.dataset.hbVideoStatus = 'processing';
    this.video.dataset.hbErrorCount = '0';
  }

  private queueNextFrame(): void {
    if (this.disposed) return;
    if (this.rafId !== null) return;
    if (this.video.paused || this.video.ended) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      void this.tick();
    });
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;

    const now = performance.now();
    this.refillTokens(now);

    try {
      if (this.canSend(now)) {
        this.consumeToken(now);
        await this.processFrame();
        this.errorCount = 0;
        this.video.dataset.hbErrorCount = '0';
      }
    } catch (error) {
      this.errorCount += 1;
      this.video.dataset.hbErrorCount = this.errorCount.toString();
      logger.withTag('handleVideos').error('Video frame processing error:', error);

      if (this.errorCount >= this.config.maxErrors) {
        this.video.dataset.hbVideoStatus = 'error';
        this.dispose();
        return;
      }
    }

    if (!this.video.paused && !this.video.ended && this.video.dataset.hbVideoStatus !== 'error') {
      this.queueNextFrame();
    }
  }

  private refillTokens(now: number): void {
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.maxFps);
    this.lastRefill = now;
  }

  private canSend(now: number): boolean {
    if (this.video.paused || this.video.ended) return false;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
    if (now < this.inflightUntil) return false;
    if (now - this.lastFrameSentAt < this.config.frameInterval) return false;
    return this.tokens >= 1;
  }

  private consumeToken(now: number): void {
    this.tokens = Math.max(0, this.tokens - 1);
    this.lastFrameSentAt = now;
    const cooldown = Math.max(100, this.lastInferenceMs);
    this.inflightUntil = now + cooldown;
    this.video.dataset.hbInflightUntil = this.inflightUntil.toString();
  }

  private async processFrame(): Promise<void> {
    const bitmap = await captureFrameBitmap(this.video);
    if (!bitmap) {
      return;
    }

    // sendSample takes ownership of the bitmap and handles cleanup
    // DO NOT close the bitmap here - it's either transferred or closed by sendSample
    await this.sendSample(
      this.video,
      bitmap,
      this.hostname,
      {
        kind: 'frame',
        frameIndex: this.frameIndex,
        timestampSec: this.video.currentTime,
      },
      this.sessionId,
    );

    this.frameIndex += 1;
    this.video.dataset.hbFrameCount = this.frameIndex.toString();
  }
}
