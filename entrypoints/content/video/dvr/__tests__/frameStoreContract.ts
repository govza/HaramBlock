/**
 * Shared DvrFrameStore contract: semantics both implementations must honor
 * (push/frameAt/eviction/discontinuity/limits/release). Bounds are loose
 * enough for the encoded ring's GOP-granular eviction (~1 s slack) while
 * still pinning the behavior the presenter depends on.
 */
import { describe, expect, it } from 'vitest';

import type { DvrCaptureFrame, DvrFrameStore, PresentableFrame } from '@/entrypoints/content/video/dvr/frameStore';

export interface FrameStoreHarness {
  create(maxDurationSec: number, maxBytes?: number): DvrFrameStore;
  frame(mediaTime: number): DvrCaptureFrame;
}

const CAPTURE_INTERVAL_SEC = 1 / 30;
/** GOP-granular eviction may over-retain by up to a keyframe interval plus a tick. */
const EVICTION_SLACK_SEC = 1.2;
const BIG = Number.MAX_SAFE_INTEGER;

/**
 * The encoded store may need a few cursor signals to decode ahead to the
 * target (spec: a covered-but-undecoded miss returns null and catches up).
 */
export function settledFrameAt(store: DvrFrameStore, mediaTime: number): PresentableFrame | null {
  let result: PresentableFrame | null = null;
  for (let i = 0; i < 20; i++) {
    const next = store.frameAt(mediaTime);
    if (next && next.mediaTime === result?.mediaTime) return next;
    result = next;
  }
  return result;
}

function fill(harness: FrameStoreHarness, store: DvrFrameStore, fromSec: number, toSec: number): void {
  for (let t = fromSec; t <= toSec + 1e-9; t += CAPTURE_INTERVAL_SEC) {
    store.push(harness.frame(t), t);
  }
}

export function runDvrFrameStoreContract(label: string, harness: FrameStoreHarness): void {
  describe(`DvrFrameStore contract: ${label}`, () => {
    it('serves the latest frame at or before the requested media time', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 0, 3);

      const frame = settledFrameAt(store, 1.5);
      expect(frame).not.toBeNull();
      expect(frame!.mediaTime).toBeLessThanOrEqual(1.5);
      expect(frame!.mediaTime).toBeGreaterThan(1.5 - 2 * CAPTURE_INTERVAL_SEC);
      store.release();
    });

    it('returns null when the buffer does not reach back that far', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 2, 3);
      expect(store.frameAt(1)).toBeNull();
      store.release();
    });

    it('tracks oldest/newest/span as frames arrive', () => {
      const store = harness.create(10, BIG);
      expect(store.oldestTime()).toBeNull();
      expect(store.newestTime()).toBeNull();
      fill(harness, store, 1, 3);
      expect(store.oldestTime()).toBeCloseTo(1, 5);
      expect(store.newestTime()).toBeCloseTo(3, 1);
      expect(store.spanSec()).toBeCloseTo(2, 1);
      store.release();
    });

    it('evicts old frames beyond the time horizon', () => {
      const store = harness.create(2, BIG);
      fill(harness, store, 0, 6);

      expect(store.oldestTime()!).toBeGreaterThan(6 - 2 - EVICTION_SLACK_SEC);
      expect(store.spanSec()).toBeGreaterThanOrEqual(2 - 2 * CAPTURE_INTERVAL_SEC);
      expect(store.frameAt(0.5)).toBeNull();
      store.release();
    });

    it('tightened limits evict immediately (budget degradation on a live store)', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 0, 5);

      store.setLimits(1, BIG);
      expect(store.oldestTime()!).toBeGreaterThan(5 - 1 - EVICTION_SLACK_SEC);
      store.release();
    });

    it('flushes on a backwards media-time jump (loop restart without seeked)', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 4, 5);
      store.push(harness.frame(0.1), 0.1);

      expect(store.oldestTime()).toBeCloseTo(0.1, 5);
      expect(store.spanSec()).toBeCloseTo(0, 5);
      const frame = settledFrameAt(store, 5);
      expect(frame?.mediaTime).toBeCloseTo(0.1, 5);
      store.release();
    });

    it('retains the buffer on a sub-tolerance backwards jitter (Firefox currentTime)', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 0, 2);
      const newest = store.newestTime()!;

      store.push(harness.frame(newest - 0.0005), newest - 0.0005);
      store.push(harness.frame(newest), newest);

      expect(store.oldestTime()).toBeCloseTo(0, 5);
      expect(store.spanSec()).toBeGreaterThan(1.5);
      store.release();
    });

    it('still flushes on a backwards step beyond the jitter tolerance', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 0, 2);
      const newest = store.newestTime()!;

      store.push(harness.frame(newest - 0.05), newest - 0.05);

      expect(store.oldestTime()).toBeCloseTo(newest - 0.05, 5);
      expect(store.spanSec()).toBeCloseTo(0, 5);
      store.release();
    });

    it('counts discontinuity flushes monotonically, never jitter drops or release', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 0, 1);
      expect(store.flushes()).toBe(0);
      const newest = store.newestTime()!;

      store.push(harness.frame(newest - 0.0005), newest - 0.0005);
      expect(store.flushes()).toBe(0);

      store.push(harness.frame(0.1), 0.1);
      expect(store.flushes()).toBe(1);
      fill(harness, store, 0.2, 1);
      store.push(harness.frame(0.5), 0.5);
      expect(store.flushes()).toBe(2);

      store.release();
      expect(store.flushes()).toBe(2);
    });
    it('never counts a before-oldest miss as a covered miss', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 2, 3);
      const before = store.coveredMisses();
      expect(store.frameAt(1)).toBeNull();
      expect(store.coveredMisses()).toBe(before);
      store.release();
    });

    it('never advances covered misses on hits', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 0, 3);
      settledFrameAt(store, 1.5);
      const settled = store.coveredMisses();
      store.frameAt(1.5);
      expect(store.coveredMisses()).toBe(settled);
      store.release();
    });

    it('release empties the store', () => {
      const store = harness.create(10, BIG);
      fill(harness, store, 0, 1);
      store.release();
      expect(store.oldestTime()).toBeNull();
      expect(store.bytes()).toBe(0);
      expect(store.frameAt(0.5)).toBeNull();
    });
  });
}
