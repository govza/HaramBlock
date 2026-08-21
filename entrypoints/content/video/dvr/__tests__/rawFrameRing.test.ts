import { describe, expect, it } from 'vitest';

import { runDvrFrameStoreContract } from '@/entrypoints/content/video/dvr/__tests__/frameStoreContract';
import { FrameRing, RawFrameRing, type RingBitmap } from '@/entrypoints/content/video/dvr/rawFrameRing';

class FakeBitmap implements RingBitmap {
  closed = false;
  constructor(
    readonly width = 100,
    readonly height = 100,
  ) {}

  close(): void {
    this.closed = true;
  }
}

const BIG = Number.MAX_SAFE_INTEGER;

describe('FrameRing', () => {
  it('serves the latest frame at or before the requested media time', () => {
    const ring = new FrameRing<FakeBitmap>(10, BIG);
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 1 });
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 2 });
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 3 });

    expect(ring.frameAt(2.5)?.mediaTime).toBe(2);
    expect(ring.frameAt(3)?.mediaTime).toBe(3);
    expect(ring.frameAt(99)?.mediaTime).toBe(3);
    // The buffer does not reach back that far: fail closed with null.
    expect(ring.frameAt(0.5)).toBeNull();
  });

  it('evicts (and closes) frames beyond the time horizon', () => {
    const ring = new FrameRing<FakeBitmap>(2, BIG);
    const first = new FakeBitmap();
    ring.push({ bitmap: first, mediaTime: 0 });
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 1 });
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 2 });
    expect(first.closed).toBe(false);

    ring.push({ bitmap: new FakeBitmap(), mediaTime: 2.5 });
    expect(first.closed).toBe(true);
    expect(ring.frameAt(0)).toBeNull();
    expect(ring.spanSec()).toBeCloseTo(1.5);
  });

  it('tightened limits evict immediately (budget degradation on a live ring)', () => {
    const ring = new FrameRing<FakeBitmap>(10, BIG);
    const first = new FakeBitmap();
    ring.push({ bitmap: first, mediaTime: 0 });
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 2 });
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 3 });

    ring.setLimits(1, BIG);
    expect(first.closed).toBe(true);
    expect(ring.oldestTime()).toBe(2);
  });

  it('evicts oldest frames when over the byte budget', () => {
    // 100×100×4 = 40 000 bytes per frame; budget fits two frames.
    const ring = new FrameRing<FakeBitmap>(1000, 90_000);
    const first = new FakeBitmap();
    ring.push({ bitmap: first, mediaTime: 0 });
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 1 });
    expect(ring.bytes()).toBe(80_000);

    ring.push({ bitmap: new FakeBitmap(), mediaTime: 2 });
    expect(first.closed).toBe(true);
    expect(ring.bytes()).toBe(80_000);
  });

  it('flushes on a backwards media-time jump (loop restart without seeked)', () => {
    const ring = new FrameRing<FakeBitmap>(10, BIG);
    const before = new FakeBitmap();
    ring.push({ bitmap: before, mediaTime: 5 });
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 0.1 });

    expect(before.closed).toBe(true);
    expect(ring.frameAt(5)?.mediaTime).toBe(0.1);
    expect(ring.spanSec()).toBe(0);
  });

  it('drops (and closes) a sub-tolerance backwards or duplicate frame without flushing', () => {
    const ring = new FrameRing<FakeBitmap>(10, BIG);
    const kept = new FakeBitmap();
    ring.push({ bitmap: kept, mediaTime: 5 });

    const jittered = new FakeBitmap();
    ring.push({ bitmap: jittered, mediaTime: 5 - 0.0005 });
    const duplicate = new FakeBitmap();
    ring.push({ bitmap: duplicate, mediaTime: 5 });

    expect(kept.closed).toBe(false);
    expect(jittered.closed).toBe(true);
    expect(duplicate.closed).toBe(true);
    expect(ring.frameAt(5)?.bitmap).toBe(kept);
    expect(ring.bytes()).toBe(40_000);
  });

  it('exposes the earliest buffered time for warm-up pinning', () => {
    const ring = new FrameRing<FakeBitmap>(10, BIG);
    expect(ring.oldestTime()).toBeNull();
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 2.5 });
    ring.push({ bitmap: new FakeBitmap(), mediaTime: 3 });
    expect(ring.oldestTime()).toBe(2.5);
    ring.release();
    expect(ring.oldestTime()).toBeNull();
  });

  it('release closes every buffered bitmap', () => {
    const ring = new FrameRing<FakeBitmap>(10, BIG);
    const bitmaps = [new FakeBitmap(), new FakeBitmap(), new FakeBitmap()];
    bitmaps.forEach((bitmap, i) => ring.push({ bitmap, mediaTime: i }));

    ring.release();
    expect(bitmaps.every(b => b.closed)).toBe(true);
    expect(ring.bytes()).toBe(0);
    expect(ring.frameAt(99)).toBeNull();
  });
});

describe('RawFrameRing covered misses', () => {
  it('stays zero: a covered frameAt always hits on the raw ring', () => {
    const store = new RawFrameRing(10, BIG);
    for (let t = 0; t <= 2; t += 0.1) store.push(new FakeBitmap(), t);
    store.frameAt(1);
    store.frameAt(-5);
    expect(store.coveredMisses()).toBe(0);
    store.release();
  });
});

runDvrFrameStoreContract('RawFrameRing', {
  create: (maxDurationSec, maxBytes = Number.MAX_SAFE_INTEGER) => new RawFrameRing(maxDurationSec, maxBytes),
  frame: () => new FakeBitmap(),
});
