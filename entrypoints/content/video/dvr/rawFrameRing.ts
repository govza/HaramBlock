/**
 * Raw-bitmap implementation of the DVR frame store (docs/VIDEO_PROCESSING.md):
 * a ring buffer of presentation-sized RGBA ImageBitmaps keyed by media time.
 * The universal fallback — works everywhere, but memory scales as
 * resolution² × fps × horizon, which is what the ring budget ladder manages.
 * The WebCodecs-encoded store (encodedFrameRing.ts) replaces it when hardware
 * allows. Bounded by both a time horizon and a byte budget; evicted frames
 * close their bitmaps.
 */

import type { DvrCaptureFrame, DvrFrameStore, PresentableFrame } from '@/entrypoints/content/video/dvr/frameStore';

/** Structural subset of ImageBitmap, so the ring is unit-testable without a DOM. */
export interface RingBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface RingFrame<B extends RingBitmap = ImageBitmap> {
  bitmap: B;
  /** Media time (video.currentTime domain) at which this frame was presented. */
  mediaTime: number;
}

const BYTES_PER_PIXEL = 4;

export class FrameRing<B extends RingBitmap = ImageBitmap> {
  private frames: RingFrame<B>[] = [];
  private totalBytes = 0;

  constructor(
    private maxDurationSec: number,
    private maxBytes: number,
  ) {}

  /** Budget degradation resizes a live ring; tighter limits evict immediately. */
  setLimits(maxDurationSec: number, maxBytes: number): void {
    this.maxDurationSec = maxDurationSec;
    this.maxBytes = maxBytes;
    this.evict();
  }

  /**
   * Append a frame. A backwards jump in media time (seek without a `seeked`
   * event, e.g. a native loop restart) is a discontinuity: the buffered
   * content no longer precedes the live edge, so the ring flushes.
   */
  push(frame: RingFrame<B>): void {
    const newest = this.frames.at(-1);
    if (newest && frame.mediaTime <= newest.mediaTime) {
      this.flush();
    }
    this.frames.push(frame);
    this.totalBytes += frame.bitmap.width * frame.bitmap.height * BYTES_PER_PIXEL;
    this.evict();
  }

  /** Latest frame at or before `mediaTime`; null when the buffer does not reach back that far. */
  frameAt(mediaTime: number): RingFrame<B> | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i];
      if (frame && frame.mediaTime <= mediaTime) return frame;
    }
    return null;
  }

  /** Media-time span currently buffered (0 with fewer than two frames). */
  spanSec(): number {
    const oldest = this.frames[0];
    const newest = this.frames.at(-1);
    return oldest && newest ? newest.mediaTime - oldest.mediaTime : 0;
  }

  /** Media time of the earliest buffered frame; null while empty. */
  oldestTime(): number | null {
    return this.frames[0]?.mediaTime ?? null;
  }

  /** Media time of the newest buffered frame; null while empty. */
  newestTime(): number | null {
    return this.frames.at(-1)?.mediaTime ?? null;
  }

  bytes(): number {
    return this.totalBytes;
  }

  release(): void {
    this.flush();
  }

  private evict(): void {
    const newest = this.frames.at(-1);
    if (!newest) return;
    while (this.frames.length > 1) {
      const oldest = this.frames[0];
      if (!oldest) break;
      const overHorizon = newest.mediaTime - oldest.mediaTime > this.maxDurationSec;
      const overBudget = this.totalBytes > this.maxBytes;
      if (!overHorizon && !overBudget) break;
      this.drop(oldest);
    }
  }

  private flush(): void {
    for (const frame of this.frames) {
      frame.bitmap.close();
    }
    this.frames = [];
    this.totalBytes = 0;
  }

  private drop(frame: RingFrame<B>): void {
    this.frames.shift();
    this.totalBytes -= frame.bitmap.width * frame.bitmap.height * BYTES_PER_PIXEL;
    frame.bitmap.close();
  }
}

/**
 * DvrFrameStore adapter over FrameRing. Capture stays outside: the adapter's
 * capture tick downscales through a canvas (budget-sized) and pushes the
 * resulting ImageBitmap. A VideoFrame arriving here is a swap-race tick
 * (the factory just exchanged an encoded store for this one mid-run) — one
 * dropped capture, closed rather than stored.
 */
export class RawFrameRing implements DvrFrameStore {
  readonly captureMode = 'bitmap';
  private readonly ring: FrameRing;

  constructor(maxDurationSec: number, maxBytes: number) {
    this.ring = new FrameRing(maxDurationSec, maxBytes);
  }

  push(frame: DvrCaptureFrame, mediaTime: number): void {
    if ('displayWidth' in frame) {
      frame.close();
      return;
    }
    this.ring.push({ bitmap: frame, mediaTime });
  }

  frameAt(mediaTime: number): PresentableFrame | null {
    const frame = this.ring.frameAt(mediaTime);
    if (!frame) return null;
    return {
      source: frame.bitmap,
      width: frame.bitmap.width,
      height: frame.bitmap.height,
      mediaTime: frame.mediaTime,
    };
  }

  /** A covered `frameAt` always hits on the raw ring: the counter never advances. */
  coveredMisses(): number {
    return 0;
  }

  spanSec(): number {
    return this.ring.spanSec();
  }

  oldestTime(): number | null {
    return this.ring.oldestTime();
  }

  newestTime(): number | null {
    return this.ring.newestTime();
  }

  bytes(): number {
    return this.ring.bytes();
  }

  setLimits(maxDurationSec: number, maxBytes: number): void {
    this.ring.setLimits(maxDurationSec, maxBytes);
  }

  release(): void {
    this.ring.release();
  }
}
