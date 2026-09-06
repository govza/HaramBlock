import { describe, expect, it, vi } from 'vitest';

import { runDvrFrameStoreContract, settledFrameAt } from '@/entrypoints/content/video/dvr/__tests__/frameStoreContract';
import {
  DELTA_CHUNK_BYTES,
  KEY_CHUNK_BYTES,
  asCaptureFrame,
  createMockCodecs,
  fakeVideoFrame,
  type MockCodecPair,
} from '@/entrypoints/content/video/dvr/__tests__/mockCodecs';
import {
  ENCODED_KEYFRAME_INTERVAL_SEC,
  EncodedFrameRing,
  type DecodedRingFrame,
  type EncodedRingCodecs,
} from '@/entrypoints/content/video/dvr/encodedFrameRing';

import type { DecodedFrameConverter } from '@/entrypoints/content/video/dvr/decodedFrameConverter';

const BIG = Number.MAX_SAFE_INTEGER;
const TICK = 1 / 30;

function makeRing(
  maxDurationSec: number,
  maxBytes = BIG,
  codecs: MockCodecPair = createMockCodecs(),
  onFatalError = vi.fn(),
) {
  const ring = new EncodedFrameRing({ maxDurationSec, maxBytes, codecs, onFatalError });
  return { ring, codecs, onFatalError };
}

function fill(ring: EncodedFrameRing, fromSec: number, toSec: number): void {
  for (let t = fromSec; t <= toSec + 1e-9; t += TICK) {
    ring.push(asCaptureFrame(fakeVideoFrame(t)), t);
  }
}

/** Ring whose decoder holds its outputs until flushed: a decoder behind the cursor. */
function makeStallingRing(maxDurationSec: number) {
  const base = createMockCodecs();
  const pending: (() => void)[] = [];
  const codecs: EncodedRingCodecs = {
    createEncoder: callbacks => base.createEncoder(callbacks),
    createDecoder: callbacks => {
      const inner = base.createDecoder({
        output: frame => pending.push(() => callbacks.output(frame)),
        error: error => callbacks.error(error),
      });
      return {
        get decodeQueueSize() {
          return pending.length;
        },
        configure: config => inner.configure(config),
        decode: chunk => inner.decode(chunk),
        reset: () => {
          pending.length = 0;
          inner.reset();
        },
        close: () => inner.close(),
      };
    },
  };
  const ring = new EncodedFrameRing({ maxDurationSec, maxBytes: BIG, codecs, onFatalError: vi.fn() });
  return { ring, flush: () => pending.splice(0).forEach(deliver => deliver()) };
}

runDvrFrameStoreContract('EncodedFrameRing', {
  create: (maxDurationSec, maxBytes = BIG) => makeRing(maxDurationSec, maxBytes).ring,
  frame: mediaTime => asCaptureFrame(fakeVideoFrame(mediaTime)),
});

describe('EncodedFrameRing', () => {
  it('closes every pushed frame (encoder owns a copy, the ring never retains the source)', () => {
    const { ring } = makeRing(10);
    const frames = [fakeVideoFrame(0), fakeVideoFrame(0.5), fakeVideoFrame(1)];
    frames.forEach(frame => ring.push(asCaptureFrame(frame), frame.timestamp / 1_000_000));
    expect(frames.every(frame => frame.closed)).toBe(true);
    ring.release();
  });

  it('configures the decoder with the requested hardware preference', () => {
    const codecs = createMockCodecs();
    const ring = new EncodedFrameRing({
      maxDurationSec: 5,
      maxBytes: BIG,
      codecs,
      onFatalError: vi.fn(),
      decoderHardwareAcceleration: 'prefer-software',
    });
    fill(ring, 0, 1);
    ring.frameAt(0.5);
    expect(codecs.decoders[0]?.lastConfig?.hardwareAcceleration).toBe('prefer-software');
    ring.release();
  });

  it('opens each GOP with a keyframe about every keyframe interval', () => {
    const { ring, codecs } = makeRing(10);
    fill(ring, 0, 3);
    const encoder = codecs.encoders[0]!;
    expect(encoder.encodeCalls).toBeGreaterThan(80);
    // Storage boundaries mirror the keyframe cadence: oldest chunk per GOP is a key.
    expect(ring.oldestTime()).toBe(0);
    // 3 s of pushes at a ~1 s keyframe interval: 3-4 keys.
    const bytesPerKey = KEY_CHUNK_BYTES - DELTA_CHUNK_BYTES;
    const keyCount = (ring.bytes() - encoder.encodeCalls * DELTA_CHUNK_BYTES) / bytesPerKey;
    expect(keyCount).toBeGreaterThanOrEqual(3 / ENCODED_KEYFRAME_INTERVAL_SEC);
    expect(keyCount).toBeLessThanOrEqual(3 / ENCODED_KEYFRAME_INTERVAL_SEC + 1);
    ring.release();
  });

  it('drops the capture tick under encoder backpressure instead of queueing', () => {
    const { ring, codecs } = makeRing(10);
    ring.push(asCaptureFrame(fakeVideoFrame(0)), 0);
    const encoder = codecs.encoders[0]!;
    encoder.encodeQueueSize = 7;
    const dropped = fakeVideoFrame(0.1);
    const before = encoder.encodeCalls;
    ring.push(asCaptureFrame(dropped), 0.1);
    expect(encoder.encodeCalls).toBe(before);
    expect(dropped.closed).toBe(true);
    ring.release();
  });

  it('closes decoded frames left behind as the presentation cursor advances', () => {
    const { ring, codecs } = makeRing(10);
    fill(ring, 0, 2);
    settledFrameAt(ring, 0.5);
    settledFrameAt(ring, 1.5);
    const decoder = codecs.decoders[0]!;
    const behind = decoder.frames.filter(frame => frame.timestamp / 1_000_000 < 1.4);
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every(frame => frame.closed)).toBe(true);
    ring.release();
  });

  it('re-warms from the GOP keyframe at or before a jumped-to target', () => {
    const { ring, codecs } = makeRing(20);
    fill(ring, 0, 6);
    settledFrameAt(ring, 0.5);
    const decoder = codecs.decoders[0]!;
    const decodesBefore = decoder.decodeCalls;

    const frame = settledFrameAt(ring, 5.5);
    expect(frame).not.toBeNull();
    expect(frame!.mediaTime).toBeLessThanOrEqual(5.5);
    expect(frame!.mediaTime).toBeGreaterThan(5.5 - 2 * TICK);
    // A frame-by-frame grind from 0.5 to 5.5 would be ~150 decodes; the keyframe
    // warm start needs at most a GOP plus the lookahead.
    expect(decoder.decodeCalls - decodesBefore).toBeLessThan(60);
    expect(decoder.resetCalls).toBeGreaterThan(0);
    ring.release();
  });

  it('never re-warms while tracking the live edge (a reset per tick would collapse fps)', () => {
    const { ring, codecs } = makeRing(10);
    fill(ring, 0, 2);
    settledFrameAt(ring, 1.8);
    const decoder = codecs.decoders[0]!;
    const resetsAtEdge = decoder.resetCalls;

    const presented = new Set<number>();
    for (let i = 1; i <= 60; i++) {
      const t = 2 + i * TICK;
      ring.push(asCaptureFrame(fakeVideoFrame(t)), t);
      const frame = ring.frameAt(t - 0.2);
      if (frame) presented.add(frame.mediaTime);
    }
    expect(decoder.resetCalls).toBe(resetsAtEdge);
    // Steady state presents nearly every captured frame, not one per GOP.
    expect(presented.size).toBeGreaterThanOrEqual(55);
    ring.release();
  });

  it('paces the cursor by media-time lag, so a sparse-interval backlog jumps instead of drifting', () => {
    const { ring } = makeRing(10);
    const sparse = 0.2;
    for (let t = 0; t <= 2 + 1e-9; t += sparse) {
      ring.push(asCaptureFrame(fakeVideoFrame(t)), t);
    }
    settledFrameAt(ring, 0.2);

    const frame = ring.frameAt(1.0);
    expect(frame).not.toBeNull();
    expect(frame!.mediaTime).toBeGreaterThan(1.0 - 2 * sparse);
    expect(frame!.mediaTime).toBeLessThanOrEqual(1.0);
    ring.release();
  });

  it('counts encoded chunks and the decoded lookahead in bytes()', () => {
    const { ring } = makeRing(10);
    fill(ring, 0, 1);
    const chunkOnly = ring.bytes();
    expect(chunkOnly).toBeGreaterThan(0);
    settledFrameAt(ring, 0.5);
    expect(ring.bytes()).toBeGreaterThan(chunkOnly);
    ring.release();
  });

  it('evicts whole GOPs under byte pressure', () => {
    // Two GOPs fit; the third forces the head GOP out.
    const gopBytes = KEY_CHUNK_BYTES + 29 * DELTA_CHUNK_BYTES;
    const { ring } = makeRing(1000, 2 * gopBytes + KEY_CHUNK_BYTES);
    fill(ring, 0, 3);
    expect(ring.bytes()).toBeLessThanOrEqual(2 * gopBytes + KEY_CHUNK_BYTES);
    expect(ring.oldestTime()!).toBeGreaterThan(0);
    ring.release();
  });

  it('drops (and closes) a sub-tolerance backwards tick without resetting the codecs', () => {
    const { ring, codecs } = makeRing(10);
    fill(ring, 0, 2);
    const encoder = codecs.encoders[0]!;
    const encodesBefore = encoder.encodeCalls;

    const jittered = fakeVideoFrame(2 - 0.0005);
    ring.push(asCaptureFrame(jittered), 2 - 0.0005);

    expect(jittered.closed).toBe(true);
    expect(encoder.encodeCalls).toBe(encodesBefore);
    expect(encoder.resetCalls).toBe(0);
    expect(ring.oldestTime()).toBe(0);
    ring.release();
  });

  it('drops (and closes) a frame-scale re-delivered backstep without resetting the codecs', () => {
    const { ring, codecs } = makeRing(10);
    fill(ring, 0, 2);
    const encoder = codecs.encoders[0]!;
    const encodesBefore = encoder.encodeCalls;

    const stale = fakeVideoFrame(2 - 0.042);
    ring.push(asCaptureFrame(stale), 2 - 0.042);

    expect(stale.closed).toBe(true);
    expect(encoder.encodeCalls).toBe(encodesBefore);
    expect(encoder.resetCalls).toBe(0);
    expect(codecs.decoders[0]?.resetCalls ?? 0).toBe(0);
    expect(ring.oldestTime()).toBe(0);
    ring.release();
  });

  it('resets encoder and decoder state on a discontinuity', () => {
    const { ring, codecs } = makeRing(10);
    fill(ring, 4, 5);
    settledFrameAt(ring, 4.5);
    ring.push(asCaptureFrame(fakeVideoFrame(0.1)), 0.1);

    expect(codecs.encoders[0]!.resetCalls).toBe(1);
    expect(codecs.decoders[0]!.resetCalls).toBeGreaterThan(0);
    expect(ring.oldestTime()).toBeCloseTo(0.1, 5);
    ring.release();
  });

  it('warm start after head-GOP eviction still lands on the covering keyframe', () => {
    const { ring } = makeRing(3);
    fill(ring, 0, 10);
    expect(ring.oldestTime()!).toBeGreaterThan(0);

    const frame = settledFrameAt(ring, 8.5);
    expect(frame).not.toBeNull();
    expect(frame!.mediaTime).toBeLessThanOrEqual(8.5);
    expect(frame!.mediaTime).toBeGreaterThan(8.5 - 2 * TICK);
    ring.release();
  });

  it('advances covered misses exactly while the decoder is behind a covered target', () => {
    const { ring, flush } = makeStallingRing(10);
    fill(ring, 0, 2);

    // Decoder outputs are held back: a covered target misses and counts.
    expect(ring.frameAt(1)).toBeNull();
    expect(ring.coveredMisses()).toBe(1);
    expect(ring.frameAt(1)).toBeNull();
    expect(ring.coveredMisses()).toBe(2);

    // Outputs land: the same target hits and the counter stays put.
    flush();
    expect(ring.frameAt(1)).not.toBeNull();
    expect(ring.coveredMisses()).toBe(2);
    ring.release();
  });

  it('keeps the covered-miss counter monotonic across a discontinuity flush', () => {
    const { ring, flush } = makeStallingRing(10);
    fill(ring, 4, 5);
    expect(ring.frameAt(4.5)).toBeNull();
    expect(ring.coveredMisses()).toBe(1);

    ring.push(asCaptureFrame(fakeVideoFrame(0.1)), 0.1);
    fill(ring, 0.2, 1);
    expect(ring.coveredMisses()).toBe(1);
    expect(ring.frameAt(0.5)).toBeNull();
    expect(ring.coveredMisses()).toBe(2);
    flush();
    ring.release();
  });

  it('a codec error tears down, reports once, and pins frameAt to null', () => {
    const codecs = createMockCodecs({ failAtEncodeCall: 40 });
    const { ring, onFatalError } = makeRing(10, BIG, codecs);
    fill(ring, 0, 3);
    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(ring.frameAt(1)).toBeNull();
    expect(ring.bytes()).toBe(0);
    expect(codecs.encoders[0]!.closed).toBe(true);
    // Pushes after the failure close their frames and go nowhere.
    const late = fakeVideoFrame(3.5);
    ring.push(asCaptureFrame(late), 3.5);
    expect(late.closed).toBe(true);
    expect(ring.oldestTime()).toBeNull();
  });
});

function makeHeldConverter() {
  const held: { frame: DecodedRingFrame; deliver: (converted: DecodedRingFrame | null) => void }[] = [];
  const converted: { source: string; closed: boolean }[] = [];
  const convertToBitmap = (frame: DecodedRingFrame): DecodedRingFrame => {
    const bitmap = { source: `bitmap:${frame.timestamp}`, closed: false };
    converted.push(bitmap);
    frame.close();
    return {
      ...bitmap,
      displayWidth: frame.displayWidth,
      displayHeight: frame.displayHeight,
      timestamp: frame.timestamp,
      close: () => {
        bitmap.closed = true;
      },
    };
  };
  const converter: DecodedFrameConverter & { released: boolean } = {
    released: false,
    convert: (frame, onConverted) => held.push({ frame, deliver: onConverted }),
    release: () => {
      converter.released = true;
    },
  };
  return {
    converter,
    converted,
    inFlight: () => held.length,
    flush: () => held.splice(0).forEach(({ frame, deliver }) => deliver(convertToBitmap(frame))),
    dropAll: () => held.splice(0).forEach(({ deliver }) => deliver(null)),
  };
}

function makeConvertingRing(maxDurationSec: number) {
  const codecs = createMockCodecs();
  const conversion = makeHeldConverter();
  const ring = new EncodedFrameRing({
    maxDurationSec,
    maxBytes: BIG,
    codecs,
    onFatalError: vi.fn(),
    convertDecoded: conversion.converter,
  });
  return { ring, codecs, ...conversion };
}

describe('EncodedFrameRing decoded-frame conversion', () => {
  it('presents the converted frame in place of the decoder output', () => {
    const { ring, flush } = makeConvertingRing(10);
    fill(ring, 0, 2);
    expect(ring.frameAt(1)).toBeNull();
    flush();
    const frame = settledFrameAt(ring, 1);
    expect(frame).not.toBeNull();
    expect(frame!.source).toBe(`bitmap:${Math.round(frame!.mediaTime * 1_000_000)}`);
    ring.release();
  });

  it('counts conversions in flight against the decode lookahead', () => {
    const { ring, codecs, inFlight, flush } = makeConvertingRing(10);
    fill(ring, 0, 3);
    ring.frameAt(0.5);
    ring.frameAt(0.5);
    const decoder = codecs.decoders[0]!;
    expect(inFlight()).toBe(decoder.decodeCalls);
    expect(decoder.decodeCalls).toBeLessThanOrEqual(8);
    flush();
    ring.frameAt(0.5);
    expect(decoder.decodeCalls).toBeGreaterThan(inFlight());
    ring.release();
  });

  it('discards a conversion that lands after a discontinuity flushed the lookahead', () => {
    const { ring, converted, flush } = makeConvertingRing(10);
    fill(ring, 0, 2);
    ring.frameAt(1);
    ring.push(asCaptureFrame(fakeVideoFrame(0)), 0);
    flush();
    expect(converted.length).toBeGreaterThan(0);
    expect(converted.every(bitmap => bitmap.closed)).toBe(true);
    expect(ring.frameAt(1)).toBeNull();
    ring.release();
  });

  it('skips a failed conversion and keeps serving later frames', () => {
    const { ring, dropAll, flush } = makeConvertingRing(10);
    fill(ring, 0, 2);
    ring.frameAt(0.5);
    dropAll();
    ring.frameAt(0.5);
    flush();
    expect(settledFrameAt(ring, 0.5)).not.toBeNull();
    ring.release();
  });

  it('releases the converter with the ring', () => {
    const { ring, converter } = makeConvertingRing(10);
    ring.release();
    expect(converter.released).toBe(true);
  });
});
