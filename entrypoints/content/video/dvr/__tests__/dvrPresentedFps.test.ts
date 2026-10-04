/**
 * Perf harness: measures the DVR's presented-fps ceiling end to end through
 * the real capture throttle (DVR_CAPTURE_INTERVAL_SEC), a real frame store,
 * and the presenter's frame-selection rule (frameAt + dedup on mediaTime,
 * mirroring videoDvrPlayer's drawKey). Parameterized over both DvrFrameStore
 * implementations — the raw ring and the (mock-codec) encoded ring.
 *
 * Simulates a 60 fps source: rVFC ticks feed the store through the throttle,
 * a 60 Hz rAF presenter reads targetTime = t − D and counts distinct
 * presented frames per second.
 */
import { describe, expect, it } from 'vitest';

import { asCaptureFrame, createMockCodecs, fakeVideoFrame } from '@/entrypoints/content/video/dvr/__tests__/mockCodecs';
import { EncodedFrameRing } from '@/entrypoints/content/video/dvr/encodedFrameRing';
import { RawFrameRing } from '@/entrypoints/content/video/dvr/rawFrameRing';
import { RING_QUALITY_LADDER } from '@/entrypoints/content/video/dvr/ringBudget';

import type { DvrCaptureFrame, DvrFrameStore } from '@/entrypoints/content/video/dvr/frameStore';

const DVR_CAPTURE_INTERVAL_SEC = RING_QUALITY_LADDER[0]!.captureIntervalSec;
const ENCODED_CAPTURE_INTERVAL_SEC = RING_QUALITY_LADDER[0]!.encodedCaptureIntervalSec;

const SOURCE_FPS = 60;
const DELAY_SEC = 1.5;
const DURATION_SEC = 5;
const MAX_BYTES = 64 * 1024 * 1024;

const fakeBitmap = { width: 640, height: 360, close: () => {} };

interface StoreCase {
  label: string;
  create: () => DvrFrameStore;
  frame: (mediaTime: number) => DvrCaptureFrame;
  captureIntervalSec: number;
  minPresentedFps: number;
}

const createEncoded = () =>
  new EncodedFrameRing({
    maxDurationSec: 5,
    maxBytes: MAX_BYTES,
    codecs: createMockCodecs(),
    onFatalError: () => {
      throw new Error('encoded store must not fail in the harness');
    },
  });

const CASES: StoreCase[] = [
  {
    label: 'RawFrameRing (~30 fps cadence)',
    create: () => new RawFrameRing(5, MAX_BYTES),
    frame: () => fakeBitmap,
    captureIntervalSec: DVR_CAPTURE_INTERVAL_SEC,
    minPresentedFps: 24,
  },
  {
    label: 'EncodedFrameRing (native cadence)',
    create: createEncoded,
    frame: mediaTime => asCaptureFrame(fakeVideoFrame(mediaTime)),
    captureIntervalSec: ENCODED_CAPTURE_INTERVAL_SEC,
    minPresentedFps: 55,
  },
];

describe.each(CASES)('DVR presented fps: $label', ({ create, frame, captureIntervalSec, minPresentedFps }) => {
  it(`presents at least ${minPresentedFps} distinct frames per second from a 60 fps source`, () => {
    const store = create();
    let lastCapturedMediaTime = -Infinity;

    const presented = new Set<number>();
    for (let tick = 0; tick < (DURATION_SEC + DELAY_SEC) * SOURCE_FPS; tick++) {
      const mediaTime = tick / SOURCE_FPS;
      // captureIntoRing's throttle, verbatim
      if (!(mediaTime - lastCapturedMediaTime < captureIntervalSec && mediaTime >= lastCapturedMediaTime)) {
        lastCapturedMediaTime = mediaTime;
        store.push(frame(mediaTime), mediaTime);
      }
      // presenter tick: same rAF cadence, delayed target, dedup on mediaTime
      const targetTime = mediaTime - DELAY_SEC;
      if (targetTime < 0) continue;
      const presentable = store.frameAt(Math.max(targetTime, store.oldestTime() ?? targetTime));
      if (presentable) presented.add(presentable.mediaTime);
    }

    const fps = presented.size / DURATION_SEC;
    expect(fps).toBeGreaterThanOrEqual(minPresentedFps);
    store.release();
  });
});

describe('DVR presented fps: Firefox-like rVFC on the encoded ring', () => {
  const FIREFOX_SOURCE_FPS = 24;
  const RAF_HZ = 60;
  const MAX_RVFC_LATENESS_SEC = 0.012;
  const SKIP_EVERY_NTH_FRAME = 7;
  const rvfcLatenessSec = (frameIndex: number) => ((frameIndex * 5) % 4) * (MAX_RVFC_LATENESS_SEC / 3);
  const toMicros = (sec: number) => Math.round(sec * 1_000_000);

  it('presents every frame rVFC delivers despite late ticks and skipped frames', () => {
    const store = createEncoded();
    let lastCapturedMediaTime = -Infinity;
    let nextFrameIndex = 0;
    const delivered: number[] = [];
    const presented = new Set<number>();

    for (let rafTick = 0; rafTick < (DURATION_SEC + DELAY_SEC) * RAF_HZ; rafTick++) {
      const wallSec = rafTick / RAF_HZ;
      while (true) {
        const mediaTime = nextFrameIndex / FIREFOX_SOURCE_FPS;
        const latenessSec = rvfcLatenessSec(nextFrameIndex);
        if (mediaTime + latenessSec > wallSec) break;
        const skipped = nextFrameIndex % SKIP_EVERY_NTH_FRAME === SKIP_EVERY_NTH_FRAME - 1;
        nextFrameIndex++;
        if (skipped) continue;
        if (!(mediaTime - lastCapturedMediaTime < ENCODED_CAPTURE_INTERVAL_SEC && mediaTime >= lastCapturedMediaTime)) {
          lastCapturedMediaTime = mediaTime;
          store.push(asCaptureFrame(fakeVideoFrame(mediaTime)), mediaTime);
          delivered.push(mediaTime);
        }
      }
      const targetTime = wallSec - DELAY_SEC;
      if (targetTime < 0) continue;
      const presentable = store.frameAt(Math.max(targetTime, store.oldestTime() ?? targetTime));
      if (presentable) presented.add(toMicros(presentable.mediaTime));
    }

    const missed = delivered.filter(mediaTime => mediaTime < DURATION_SEC && !presented.has(toMicros(mediaTime)));
    expect(delivered.length).toBeGreaterThan(DURATION_SEC * FIREFOX_SOURCE_FPS * 0.8);
    expect(missed).toEqual([]);
    store.release();
  });
});
