import { foldToMediaTime } from '@/entrypoints/content/video/loopClock';
import { SAMPLE_FLOOR_MS } from '@/entrypoints/content/video/maskTiming';

export const LIVE_SAMPLE_TIMEOUT_MS = 3_000;

export interface LiveSamplerOptions {
  video: HTMLVideoElement;
  sample(timestampSec: number): void;
}

export class LiveSampler {
  private stopTicker: (() => void) | null = null;
  private inflightSince: number | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private queuedOnce = false;

  constructor(private readonly options: LiveSamplerOptions) {}

  get running(): boolean {
    return this.stopTicker !== null;
  }

  start(): void {
    if (this.stopTicker) return;
    this.stopTicker = startFrameTicker(this.options.video, (at, mediaTime) => {
      if (this.busy(at) || at - this.lastSentAt < SAMPLE_FLOOR_MS) return;
      this.send(at, mediaTime);
    });
  }

  stop(): void {
    this.stopTicker?.();
    this.stopTicker = null;
  }

  requestOnce(): void {
    const now = performance.now();
    if (this.busy(now)) {
      this.queuedOnce = true;
      return;
    }
    const { video } = this.options;
    this.send(now, foldToMediaTime(video.currentTime, video.duration));
  }

  settle(): void {
    this.inflightSince = null;
    if (!this.queuedOnce) return;
    this.queuedOnce = false;
    this.requestOnce();
  }

  private busy(now: number): boolean {
    return this.inflightSince !== null && now - this.inflightSince < LIVE_SAMPLE_TIMEOUT_MS;
  }

  private send(at: number, mediaTime: number): void {
    this.inflightSince = at;
    this.lastSentAt = at;
    this.options.sample(mediaTime);
  }
}

function startFrameTicker(video: HTMLVideoElement, onFrame: (at: number, mediaTime: number) => void): () => void {
  if (typeof video.requestVideoFrameCallback === 'function') {
    let stopped = false;
    let callbackId = 0;
    const loop = () => {
      callbackId = video.requestVideoFrameCallback(now => {
        if (stopped) return;
        onFrame(now, foldToMediaTime(video.currentTime, video.duration));
        loop();
      });
    };
    loop();
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback(callbackId);
    };
  }
  let rafId: number | null = null;
  const tick = () => {
    rafId = requestAnimationFrame(tick);
    if (video.paused || video.ended || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    onFrame(performance.now(), foldToMediaTime(video.currentTime, video.duration));
  };
  rafId = requestAnimationFrame(tick);
  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  };
}
