/**
 * Perf harness: measures the DVR's presented-fps ceiling end to end through
 * the real capture throttle (DVR_CAPTURE_INTERVAL_SEC), the real FrameRing,
 * and the presenter's frame-selection rule (frameAt + dedup on mediaTime,
 * mirroring videoDvrPlayer's drawKey).
 *
 * Simulates a 60 fps source: rVFC ticks feed the ring through the throttle,
 * a 60 Hz rAF presenter reads targetTime = t − D and counts distinct
 * presented frames per second.
 */
import { describe, expect, it } from 'vitest';

import { FrameRing } from '@/entrypoints/content/video/dvr/frameRing';
import { RING_QUALITY_LADDER } from '@/entrypoints/content/video/dvr/ringBudget';

/** The harness guards the full-quality tier — the cadence every session gets under budget. */
const DVR_CAPTURE_INTERVAL_SEC = RING_QUALITY_LADDER[0]!.captureIntervalSec;

const SOURCE_FPS = 60;
const DELAY_SEC = 1.5;
const DURATION_SEC = 5;
const FRAME_BYTES = { width: 640, height: 360, close: () => {} };

describe('DVR presented fps', () => {
  it('presents at least 24 distinct frames per second from a 60 fps source', () => {
    const ring = new FrameRing<typeof FRAME_BYTES>(5, 64 * 1024 * 1024);
    let lastCapturedMediaTime = -Infinity;

    const presented = new Set<number>();
    for (let tick = 0; tick < (DURATION_SEC + DELAY_SEC) * SOURCE_FPS; tick++) {
      const mediaTime = tick / SOURCE_FPS;
      // captureIntoRing's throttle, verbatim
      if (!(mediaTime - lastCapturedMediaTime < DVR_CAPTURE_INTERVAL_SEC && mediaTime >= lastCapturedMediaTime)) {
        lastCapturedMediaTime = mediaTime;
        ring.push({ bitmap: FRAME_BYTES, mediaTime });
      }
      // presenter tick: same rAF cadence, delayed target, dedup on mediaTime
      const targetTime = mediaTime - DELAY_SEC;
      if (targetTime < 0) continue;
      const frame = ring.frameAt(Math.max(targetTime, ring.oldestTime() ?? targetTime));
      if (frame) presented.add(frame.mediaTime);
    }

    const fps = presented.size / DURATION_SEC;
    expect(fps).toBeGreaterThanOrEqual(24);
  });
});
