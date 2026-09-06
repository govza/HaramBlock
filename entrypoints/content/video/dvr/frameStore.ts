/**
 * Storage seam of the DVR presentation path (docs/VIDEO_PROCESSING.md): the
 * interface between capture/presentation and the frame buffer. Two
 * implementations exist — a raw ImageBitmap ring (rawFrameRing.ts, the
 * universal fallback) and a WebCodecs-encoded ring (encodedFrameRing.ts,
 * ~50-100x smaller) — selected per DVR run by frameStoreFactory.ts.
 *
 * Presentation reads are cursor-shaped, not random-access: the presenter walks
 * forward through media time, so an encoded implementation can decode ahead
 * sequentially and use each `frameAt` call as its cursor signal.
 */

/**
 * A backwards step in capture media time within this tolerance is a
 * re-delivered stale frame, not a seek: the frame is dropped, the buffer and
 * codec state retained. Covers Firefox's `currentTime` microsecond jitter and
 * its rVFC re-ordering (one or two frame intervals, ≤ 0.083 s, every 15-40 s)
 * that would otherwise flush the ring and freeze the delay line. Sized in
 * absolute media seconds so the store needs no learnt frame rate; it equals
 * the probe's frame-relative non-seek bucket (BACKSTEP_SEEK_FRAMES) at 24 fps
 * and diverges from it at other rates. A loop restart or a real seek without
 * a `seeked` event is usually far larger; a sub-tolerance seek is harmless
 * because the ring still holds frames at and before the new position.
 */
export const STALE_FRAME_TOLERANCE_SEC = 0.5;

/**
 * A re-delivered stale frame is one delivery, at most two; a clip shorter than
 * STALE_FRAME_TOLERANCE_SEC looping natively would otherwise have every frame
 * of its next iteration dropped as stale. More consecutive sub-tolerance
 * backsteps than this is a discontinuity after all.
 */
export const MAX_CONSECUTIVE_STALE_FRAMES = 3;

export function isStaleBackstep(newestMediaTime: number, mediaTime: number, consecutiveStaleDrops: number): boolean {
  return (
    newestMediaTime - mediaTime <= STALE_FRAME_TOLERANCE_SEC && consecutiveStaleDrops < MAX_CONSECUTIVE_STALE_FRAMES
  );
}

/** How the capture tick must hand frames to this store. */
export type DvrCaptureMode = 'bitmap' | 'video-frame';

/** Which implementation currently backs a store (debug/e2e visibility, budget demand). */
export type DvrStoreKind = 'raw' | 'encoded';

/**
 * What the capture tick pushes. Raw stores receive presentation-sized
 * ImageBitmaps (the capture canvas downscale); the encoded store receives
 * zero-copy VideoFrames taken straight off the video element.
 */
export type DvrCaptureFrame = ImageBitmap | VideoFrame;

export interface PresentableFrame {
  /** Drawable by the presenter's 2D context (ImageBitmap or decoded VideoFrame). */
  readonly source: CanvasImageSource;
  /** Source pixel dimensions for the drawImage src rect (VideoFrame has no width/height). */
  readonly width: number;
  readonly height: number;
  /** Media time (video.currentTime domain) at which this frame was presented live. */
  readonly mediaTime: number;
}

export interface DvrFrameStore {
  /** May change over the store's lifetime (factory swaps raw ↔ encoded); read per capture tick. */
  readonly captureMode: DvrCaptureMode;
  /**
   * Ingest one live frame at the capture tick. Takes ownership of the frame:
   * the store closes it on eviction, flush, or rejection (backpressure). A
   * backwards jump in media time beyond STALE_FRAME_TOLERANCE_SEC is a
   * discontinuity — the store flushes its buffer and any codec state; a
   * sub-tolerance backwards or duplicate frame is a re-delivered stale frame,
   * dropped with the buffer retained. Returns whether the frame was accepted;
   * a dropped frame (stale, backpressure, swap race) must not advance the
   * caller's capture position.
   */
  push(frame: DvrCaptureFrame, mediaTime: number): boolean;
  /**
   * Latest decodable frame at or before `mediaTime`, or null when not (yet)
   * available. Synchronous: the encoded store serves it from its decode-ahead
   * queue and uses the call as the cursor signal for further decode-ahead. A
   * miss on a time the store covers but has not decoded yet returns null (the
   * presenter holds its last frame, same as the warm-up pin) and triggers
   * catch-up decode. The returned frame stays valid until the next `frameAt`
   * or `push` call — the presenter draws it within the same tick.
   */
  frameAt(mediaTime: number): PresentableFrame | null;
  /**
   * Monotonic count of covered misses: `frameAt` calls that returned null for
   * a media time inside the buffered span (decoder behind the target; the raw
   * ring never advances it). Never resets — readers diff successive values.
   */
  coveredMisses(): number;
  /**
   * Monotonic count of discontinuity flushes (backwards media time beyond the
   * jitter tolerance, or a codec reconfiguration). Release does not count.
   * Never resets — readers diff successive values.
   */
  flushes(): number;
  /**
   * Frames decoded (or being converted) but not yet presented: how far the
   * presentation pipeline runs ahead of the cursor. Always 0 on the raw ring.
   */
  lookaheadFrames(): number;
  /** Media-time span currently buffered (0 with fewer than two frames). */
  spanSec(): number;
  /** Media time of the earliest buffered frame; null while empty. */
  oldestTime(): number | null;
  /** Media time of the newest buffered frame; null while empty. */
  newestTime(): number | null;
  /** Actual retained bytes (bitmaps, or encoded chunks + decode queue). */
  bytes(): number;
  /** Budget degradation resizes a live store; tighter limits evict immediately. */
  setLimits(maxDurationSec: number, maxBytes: number): void;
  /** Free every buffered frame and any codec resources. Terminal. */
  release(): void;
}
