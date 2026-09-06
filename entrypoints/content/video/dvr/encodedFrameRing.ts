/**
 * WebCodecs implementation of the DVR frame store (docs/VIDEO_PROCESSING.md):
 * capture ticks hand zero-copy VideoFrames to a hardware H.264 encoder, the
 * ring stores encoded chunks grouped by GOP (~50-100x smaller than raw RGBA),
 * and a single decoder follows the presentation cursor with a small decoded
 * lookahead so `frameAt` stays synchronous. Selected by frameStoreFactory.ts
 * when the capability probe passes; any codec error swaps the session back to
 * a raw ring mid-run and marks it webcodecs-ineligible.
 *
 * Codec construction is injected (EncodedRingCodecs) so unit tests run a
 * deterministic mock encoder/decoder pair — no real WebCodecs in vitest.
 */

import {
  isStaleBackstep,
  type DvrCaptureFrame,
  type DvrFrameStore,
  type PresentableFrame,
} from '@/entrypoints/content/video/dvr/frameStore';
import { getLogger } from '@/utils/telemetry';

import type { DecodedFrameConverter } from '@/entrypoints/content/video/dvr/decodedFrameConverter';

const log = getLogger('encodedFrameRing');

/** Force a keyframe about once a second: the eviction and warm-start granularity. */
export const ENCODED_KEYFRAME_INTERVAL_SEC = 1;
/** Backpressure cap: a dropped tick is a permanently lost presented frame, so sized for 60 fps bursts. */
const ENCODE_QUEUE_CAP = 6;
/** Decoded lookahead target past the cursor (~130 ms at native 60 fps capture). */
const DECODE_LOOKAHEAD_FRAMES = 8;
/** Never queue more than this into the decoder; it falls behind, frameAt pins. */
const DECODE_QUEUE_CAP = 16;
/** Cursor more than this far behind the target: re-warm from a keyframe instead of grinding. */
const REWARM_BEHIND_SEC = 2;
const PACED_ADVANCE_MAX_LAG_SEC = 0.17;
const MICROS_PER_SEC = 1_000_000;
const BYTES_PER_PIXEL = 4;

/** Structural subset of EncodedVideoChunk: what storage and the decoder need. */
export interface StoredEncodedChunk {
  readonly type: 'key' | 'delta';
  /** Microseconds; carries the capture media time end to end. */
  readonly timestamp: number;
  readonly byteLength: number;
}

/** Structural subset of a decoded VideoFrame, so tests need no DOM. */
export interface DecodedRingFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Microseconds, media-time domain (round-trips from the encoded chunk). */
  readonly timestamp: number;
  close(): void;
}

export interface RingEncoder {
  readonly encodeQueueSize: number;
  configure(config: VideoEncoderConfig): void;
  encode(frame: VideoFrame, options?: { keyFrame?: boolean }): void;
  reset(): void;
  close(): void;
}

export interface RingDecoder {
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: StoredEncodedChunk): void;
  reset(): void;
  close(): void;
}

export interface EncoderCallbacks {
  output(chunk: StoredEncodedChunk, metadata?: { decoderConfig?: VideoDecoderConfig }): void;
  error(error: unknown): void;
}

export interface DecoderCallbacks {
  output(frame: DecodedRingFrame): void;
  error(error: unknown): void;
}

/** Codec construction seam: real WebCodecs in the browser, deterministic mocks in vitest. */
export interface EncodedRingCodecs {
  createEncoder(callbacks: EncoderCallbacks): RingEncoder;
  createDecoder(callbacks: DecoderCallbacks): RingDecoder;
}

/** H.264 main profile, level picked by resolution (macroblock rate bounds the level). */
export function avcCodecString(width: number, height: number): string {
  const pixels = width * height;
  if (pixels <= 1280 * 720) return 'avc1.4d001f'; // main 3.1
  if (pixels <= 1920 * 1088) return 'avc1.4d0028'; // main 4.0
  return 'avc1.4d0033'; // main 5.1
}

/** ~4 Mbps at 720p, ~8 Mbps at 1080p: linear in pixel count, clamped to sane bounds. */
export function encodedBitrate(width: number, height: number): number {
  const bitsPerPixelStream = 4_000_000 / (1280 * 720);
  return Math.round(Math.min(16_000_000, Math.max(1_000_000, width * height * bitsPerPixelStream)));
}

export function encoderConfigFor(width: number, height: number): VideoEncoderConfig {
  return {
    codec: avcCodecString(width, height),
    width,
    height,
    bitrate: encodedBitrate(width, height),
    framerate: 60,
    // 'realtime' lets the encoder drop frames to chase latency — wrong for a
    // buffer whose latency is D, not encoder-bound; 'quality' encodes them all.
    latencyMode: 'quality',
    avc: { format: 'annexb' },
  };
}

/** Real WebCodecs pair; the thin wrappers keep the injectable interfaces structural. */
export function createWebCodecsPair(): EncodedRingCodecs {
  return {
    createEncoder: callbacks => {
      const encoder = new VideoEncoder({
        output: (chunk, metadata) => callbacks.output(chunk, metadata ?? undefined),
        error: error => callbacks.error(error),
      });
      return {
        get encodeQueueSize() {
          return encoder.encodeQueueSize;
        },
        configure: config => encoder.configure(config),
        encode: (frame, options) => encoder.encode(frame, options),
        reset: () => encoder.reset(),
        close: () => encoder.close(),
      };
    },
    createDecoder: callbacks => {
      const decoder = new VideoDecoder({
        output: frame => callbacks.output(frame),
        error: error => callbacks.error(error),
      });
      return {
        get decodeQueueSize() {
          return decoder.decodeQueueSize;
        },
        configure: config => decoder.configure(config),
        decode: chunk => decoder.decode(chunk as EncodedVideoChunk),
        reset: () => decoder.reset(),
        close: () => decoder.close(),
      };
    },
  };
}

interface StoredChunkEntry {
  chunk: StoredEncodedChunk;
  mediaTime: number;
}

/** Chunks from one keyframe (inclusive) to the next: the eviction and warm-start unit. */
interface Gop {
  chunks: StoredChunkEntry[];
}

interface DecodeCursor {
  gop: Gop;
  chunkIndex: number;
}

export interface EncodedFrameRingOptions {
  maxDurationSec: number;
  maxBytes: number;
  codecs: EncodedRingCodecs;
  /**
   * Fired once on the first encoder/decoder error, after this store has torn
   * its codecs down: the factory swaps the session to a fresh raw ring and
   * marks it webcodecs-ineligible for its lifetime.
   */
  onFatalError: (error: unknown) => void;
  convertDecoded?: DecodedFrameConverter | null;
}

function presentableSource(frame: DecodedRingFrame): CanvasImageSource {
  if ('source' in frame) return (frame as { source: CanvasImageSource }).source;
  return frame as unknown as CanvasImageSource;
}
export class EncodedFrameRing implements DvrFrameStore {
  readonly captureMode = 'video-frame';

  private maxDurationSec: number;
  private maxBytes: number;
  private readonly codecs: EncodedRingCodecs;
  private readonly onFatalError: (error: unknown) => void;
  private readonly convertDecoded: DecodedFrameConverter | null;

  private encoder: RingEncoder | null = null;
  private encoderConfig: VideoEncoderConfig | null = null;
  private decoder: RingDecoder | null = null;
  private decoderConfig: VideoDecoderConfig | null = null;

  private gops: Gop[] = [];
  /** Sorted GOP keyframe media times, aligned with `gops`; warm start binary-searches it. */
  private keyframeTimes: number[] = [];
  private chunkBytes = 0;
  private coveredMissCount = 0;
  private flushCount = 0;
  private lastPushedMediaTime = Number.NEGATIVE_INFINITY;
  private consecutiveStaleDrops = 0;
  private lastKeyframeMediaTime = Number.NEGATIVE_INFINITY;
  private needKeyframe = true;

  /** Decoded lookahead, ordered by timestamp; [0] is the presentation candidate after trimming. */
  private decoded: DecodedRingFrame[] = [];
  /** Conversions in flight between the decoder and `decoded`: lookahead budget already spent. */
  private converting = 0;
  /** Bumped whenever `decoded` is cleared, so a conversion from before the clear is discarded on landing. */
  private decodedGeneration = 0;
  private cursor: DecodeCursor | null = null;
  /** Media time of the last chunk fed to the decoder; gauges how far decode trails the target. */
  private lastQueuedMediaTime: number | null = null;

  private failed = false;
  private released = false;

  constructor(options: EncodedFrameRingOptions) {
    this.maxDurationSec = options.maxDurationSec;
    this.maxBytes = options.maxBytes;
    this.codecs = options.codecs;
    this.onFatalError = options.onFatalError;
    this.convertDecoded = options.convertDecoded ?? null;
  }

  push(frame: DvrCaptureFrame, mediaTime: number): boolean {
    if (this.released || this.failed || !('displayWidth' in frame)) {
      // An ImageBitmap here is a swap-race tick (the factory just exchanged a
      // raw store for this one); one dropped capture is harmless.
      frame.close();
      return false;
    }
    try {
      // A backwards jump (seek/loop restart) or a mid-run resolution change
      // (MSE rendition switch) is a discontinuity: buffered chunks no longer
      // precede the live edge / match the codec config, so everything flushes.
      // A sub-tolerance backwards step or duplicate timestamp is a re-delivered
      // stale frame, not a seek: drop the tick, keep the buffer and codec state.
      const config = this.encoderConfig;
      if (config && (config.width !== frame.displayWidth || config.height !== frame.displayHeight)) {
        this.discontinuity();
        this.encoderConfig = null;
      }
      if (mediaTime <= this.lastPushedMediaTime) {
        if (isStaleBackstep(this.lastPushedMediaTime, mediaTime, this.consecutiveStaleDrops)) {
          this.consecutiveStaleDrops++;
          return false;
        }
        this.discontinuity();
      }
      this.consecutiveStaleDrops = 0;
      const encoder = this.ensureEncoder(frame.displayWidth, frame.displayHeight);
      if (encoder.encodeQueueSize > ENCODE_QUEUE_CAP) {
        // Backpressure: drop the tick rather than queueing behind a slow encoder.
        frame.close();
        return false;
      }
      const keyFrame = this.needKeyframe || mediaTime - this.lastKeyframeMediaTime >= ENCODED_KEYFRAME_INTERVAL_SEC;
      if (keyFrame) {
        this.needKeyframe = false;
        this.lastKeyframeMediaTime = mediaTime;
      }
      encoder.encode(frame, { keyFrame });
      this.lastPushedMediaTime = mediaTime;
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      frame.close();
    }
  }

  frameAt(mediaTime: number): PresentableFrame | null {
    if (this.released || this.failed) return null;
    // Chunk timestamps are integer microseconds (rounded at capture), so a
    // frame can quantize up to 0.5 µs past the exact target; 1 µs of slack
    // keeps "at or before" from skipping that frame for a tick.
    const targetMicros = mediaTime * MICROS_PER_SEC + 1;

    // Advance one frame per read so burst-delivered frames are not skipped; a
    // backlog past the pacing bound (media time, not a frame count) jumps.
    let eligible = 0;
    while (eligible + 1 < this.decoded.length && this.decoded[eligible + 1]!.timestamp <= targetMicros) {
      eligible++;
    }
    const lagMicros = eligible > 0 ? this.decoded[eligible]!.timestamp - this.decoded[0]!.timestamp : 0;
    const advance = lagMicros > PACED_ADVANCE_MAX_LAG_SEC * MICROS_PER_SEC ? eligible : Math.min(eligible, 1);
    for (let i = 0; i < advance; i++) {
      this.decoded.shift()!.close();
    }

    try {
      this.scheduleDecodeAhead(mediaTime, targetMicros);
    } catch (error) {
      this.fail(error);
      return null;
    }

    const candidate = this.decoded[0];
    if (!candidate || candidate.timestamp > targetMicros) {
      // A null on a covered time means this store is behind the target — a
      // stall, distinct from a before-oldest miss (evicted content). Covered
      // reaches to the newest *captured* time: a lagging encode pipeline
      // starves presentation like a slow decoder and must count too.
      const oldest = this.oldestTime();
      const newest = this.newestTime();
      const coveredEnd = Math.max(newest ?? Number.NEGATIVE_INFINITY, this.lastPushedMediaTime);
      if (oldest !== null && mediaTime >= oldest && mediaTime <= coveredEnd) {
        this.coveredMissCount++;
      }
      return null;
    }
    return {
      source: presentableSource(candidate),
      width: candidate.displayWidth,
      height: candidate.displayHeight,
      mediaTime: candidate.timestamp / MICROS_PER_SEC,
    };
  }

  coveredMisses(): number {
    return this.coveredMissCount;
  }

  flushes(): number {
    return this.flushCount;
  }

  spanSec(): number {
    const oldest = this.oldestTime();
    const newest = this.newestTime();
    return oldest !== null && newest !== null ? newest - oldest : 0;
  }

  oldestTime(): number | null {
    return this.gops[0]?.chunks[0]?.mediaTime ?? null;
  }

  newestTime(): number | null {
    return this.gops.at(-1)?.chunks.at(-1)?.mediaTime ?? null;
  }

  /** Encoded chunks plus the decoded lookahead (a few RGBA frames). */
  bytes(): number {
    let decodedBytes = 0;
    for (const frame of this.decoded) {
      decodedBytes += frame.displayWidth * frame.displayHeight * BYTES_PER_PIXEL;
    }
    return this.chunkBytes + decodedBytes;
  }

  setLimits(maxDurationSec: number, maxBytes: number): void {
    this.maxDurationSec = maxDurationSec;
    this.maxBytes = maxBytes;
    this.evict();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.teardownCodecs();
    this.clearStorage();
    this.convertDecoded?.release();
  }

  private ensureEncoder(width: number, height: number): RingEncoder {
    if (!this.encoder) {
      this.encoder = this.codecs.createEncoder({
        output: (chunk, metadata) => this.onEncoderOutput(chunk, metadata),
        error: error => this.fail(error),
      });
    }
    if (!this.encoderConfig) {
      this.encoderConfig = encoderConfigFor(width, height);
      this.encoder.configure(this.encoderConfig);
      this.needKeyframe = true;
    }
    return this.encoder;
  }

  private onEncoderOutput(chunk: StoredEncodedChunk, metadata?: { decoderConfig?: VideoDecoderConfig }): void {
    if (this.released || this.failed) return;
    if (metadata?.decoderConfig) this.decoderConfig = metadata.decoderConfig;
    const mediaTime = chunk.timestamp / MICROS_PER_SEC;
    if (chunk.type === 'key') {
      this.gops.push({ chunks: [] });
      this.keyframeTimes.push(mediaTime);
    } else if (this.gops.length === 0) {
      // Delta with no preceding keyframe (output raced a discontinuity flush):
      // undecodable, drop it.
      return;
    }
    this.gops.at(-1)!.chunks.push({ chunk, mediaTime });
    this.chunkBytes += chunk.byteLength;
    this.evict();
  }

  /**
   * Keep the decoder a few frames ahead of the presentation cursor. Re-warms
   * from the GOP keyframe at/before the target after a start, discontinuity,
   * or when the cursor drifted too far from the target to catch up frame by
   * frame.
   */
  private scheduleDecodeAhead(targetSec: number, targetMicros: number): void {
    if (this.gops.length === 0) return;
    const oldest = this.oldestTime();
    if (oldest === null || targetSec < oldest) return;

    // Rewarm only on a genuine dislocation: no cursor yet, the target moved
    // behind the decode window, or the decoder ground too far behind to catch
    // up frame by frame. A cursor idling past the last chunk is the normal
    // live-edge state — rewarming there would reset the decoder every tick
    // and collapse presented fps to one frame per GOP. All comparisons use
    // the caller's quantization-tolerant targetMicros: comparing raw float
    // seconds against rounded-up chunk timestamps would misread a caught-up
    // decode window as "ahead of the target" and thrash rewarms.
    const decodedHead = this.decoded[0];
    const needsRewarm =
      this.cursor === null ||
      (decodedHead !== undefined && decodedHead.timestamp > targetMicros) ||
      (this.lastQueuedMediaTime !== null && this.lastQueuedMediaTime < targetSec - REWARM_BEHIND_SEC);
    if (needsRewarm) this.rewarmAt(targetSec);
    let { cursor } = this;
    if (!cursor) return;

    const decoder = this.ensureDecoder();
    if (!decoder) return;
    const aheadDecoded = this.decoded.filter(frame => frame.timestamp > targetMicros).length;
    let inFlightBudget = DECODE_LOOKAHEAD_FRAMES - aheadDecoded - decoder.decodeQueueSize - this.converting;
    while (inFlightBudget > 0 && decoder.decodeQueueSize < DECODE_QUEUE_CAP) {
      const entry = cursor.gop.chunks[cursor.chunkIndex];
      if (!entry) {
        const nextGop: Gop | undefined = this.gops[this.gops.indexOf(cursor.gop) + 1];
        if (!nextGop) break; // live edge: nothing more to decode yet
        cursor = { gop: nextGop, chunkIndex: 0 };
        this.cursor = cursor;
        continue;
      }
      decoder.decode(entry.chunk);
      this.lastQueuedMediaTime = entry.mediaTime;
      cursor.chunkIndex++;
      inFlightBudget--;
    }
  }

  /** Point the cursor at the keyframe of the GOP covering `targetSec` and reset decode state. */
  private rewarmAt(targetSec: number): void {
    // Binary search the keyframe index: the last GOP whose keyframe is at or
    // before the target (index 0 when the target precedes every keyframe), so
    // warm starts stay O(log n) in buffered GOPs as the horizon grows.
    let lo = 0;
    let hi = this.keyframeTimes.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.keyframeTimes[mid]! <= targetSec) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const gop = this.gops[found];
    if (!gop || gop.chunks.length === 0) {
      this.cursor = null;
      return;
    }
    this.closeDecoded();
    if (this.decoder) {
      this.decoder.reset();
      this.configureDecoder(this.decoder);
    }
    this.cursor = { gop, chunkIndex: 0 };
    this.lastQueuedMediaTime = null;
  }

  private ensureDecoder(): RingDecoder | null {
    if (!this.decoder) {
      this.decoder = this.codecs.createDecoder({
        output: frame => this.onDecoderOutput(frame),
        error: error => this.fail(error),
      });
      this.configureDecoder(this.decoder);
    }
    return this.decoder;
  }

  private configureDecoder(decoder: RingDecoder): void {
    const config = this.decoderConfig ?? (this.encoderConfig ? { codec: this.encoderConfig.codec } : null);
    if (config) decoder.configure(config);
  }

  private onDecoderOutput(frame: DecodedRingFrame): void {
    if (this.released || this.failed) {
      frame.close();
      return;
    }
    if (!this.convertDecoded) {
      this.admitDecoded(frame);
      return;
    }
    const generation = this.decodedGeneration;
    this.converting++;
    this.convertDecoded.convert(frame, converted => {
      this.converting--;
      if (!converted) return;
      if (this.released || this.failed || generation !== this.decodedGeneration) {
        converted.close();
        return;
      }
      this.admitDecoded(converted);
    });
  }

  private admitDecoded(frame: DecodedRingFrame): void {
    // Outputs arrive in decode (= presentation, no B-frames in realtime avc)
    // order; a stale frame racing a rewarm reset would break the ordering
    // invariant, so drop anything not newer than the current tail.
    const tail = this.decoded.at(-1);
    if (tail && frame.timestamp <= tail.timestamp) {
      frame.close();
      return;
    }
    this.decoded.push(frame);
  }

  /**
   * Seek/loop restart or rendition switch: buffered chunks, decoded frames,
   * and codec state all flush; the next push restarts the stream on a
   * keyframe.
   */
  private discontinuity(): void {
    this.flushCount++;
    this.lastPushedMediaTime = Number.NEGATIVE_INFINITY;
    if (this.encoder && this.encoderConfig) {
      this.encoder.reset();
      this.encoder.configure(this.encoderConfig);
    }
    this.needKeyframe = true;
    this.lastKeyframeMediaTime = Number.NEGATIVE_INFINITY;
    this.clearStorage();
    if (this.decoder) {
      this.decoder.reset();
      this.configureDecoder(this.decoder);
    }
  }

  private evict(): void {
    // Horizon: drop head GOPs only while the remainder still spans the horizon
    // (GOP granularity over-retains slightly rather than under-retaining).
    const newest = this.newestTime();
    if (newest !== null) {
      while (this.gops.length > 1) {
        const nextFirst = this.gops[1]?.chunks[0];
        if (!nextFirst || newest - nextFirst.mediaTime < this.maxDurationSec) break;
        this.dropHeadGop();
      }
    }
    // Byte budget: must free memory even when it shortens the span below the horizon.
    while (this.gops.length > 1 && this.chunkBytes > this.maxBytes) {
      this.dropHeadGop();
    }
  }

  private dropHeadGop(): void {
    const gop = this.gops.shift();
    if (!gop) return;
    this.keyframeTimes.shift();
    for (const entry of gop.chunks) {
      this.chunkBytes -= entry.chunk.byteLength;
    }
    if (this.cursor?.gop === gop) this.cursor = null;
  }

  private clearStorage(): void {
    this.gops = [];
    this.keyframeTimes = [];
    this.chunkBytes = 0;
    this.cursor = null;
    this.lastQueuedMediaTime = null;
    this.closeDecoded();
  }

  private closeDecoded(): void {
    for (const frame of this.decoded) {
      frame.close();
    }
    this.decoded = [];
    this.decodedGeneration++;
  }

  private fail(error: unknown): void {
    if (this.failed || this.released) return;
    this.failed = true;
    // DOMException stringifies to '[object DOMException]' in some consoles;
    // name/message is the identifiable form.
    const detail = error instanceof DOMException ? `${error.name}: ${error.message}` : error;
    log.warn('dvr.encoded_ring.failed', { detail });
    this.teardownCodecs();
    this.clearStorage();
    this.onFatalError(error);
  }

  private teardownCodecs(): void {
    try {
      this.encoder?.close();
    } catch {
      // Already closed by the failing codec itself.
    }
    try {
      this.decoder?.close();
    } catch {
      // Already closed by the failing codec itself.
    }
    this.encoder = null;
    this.decoder = null;
  }
}
