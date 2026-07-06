import { describe, expect, it } from 'vitest';

import { FrameRing, type RingBitmap } from '@/entrypoints/content/video/dvr/frameRing';

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
