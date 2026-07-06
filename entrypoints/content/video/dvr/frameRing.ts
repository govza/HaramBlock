/**
 * Ring buffer of captured video frames for the DVR presentation path
 * (docs/VIDEO_PROCESSING.md). Frames are keyed by their media time so the
 * presenter can look up "the frame displayed `delay` seconds ago". Bounded by
 * both a time horizon and a byte budget; evicted frames close their bitmaps.
 */

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
    private readonly maxDurationSec: number,
    private readonly maxBytes: number,
  ) {}

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
