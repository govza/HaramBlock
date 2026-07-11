import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaptureStageTimeoutError, waitForVideoFrameAt } from '@/entrypoints/content/video/frameCapture';

class FakeVideo extends EventTarget {
  currentTime = 0;
  readyState = 0;
  seeking = true;
}

describe('waitForVideoFrameAt', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves from observable Firefox decoder state when seeked is omitted', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    const video = new FakeVideo();

    const waiting = waitForVideoFrameAt(video as unknown as HTMLVideoElement, 4.25, 1_000);
    video.readyState = 2;
    video.seeking = false;
    await vi.advanceTimersByTimeAsync(50);

    await expect(waiting).resolves.toBeUndefined();
  });

  it('rejects a stalled decoder within its stage deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    const video = new FakeVideo();

    const waiting = waitForVideoFrameAt(video as unknown as HTMLVideoElement, 8, 200);
    const rejection = expect(waiting).rejects.toBeInstanceOf(CaptureStageTimeoutError);
    await vi.advanceTimersByTimeAsync(200);
    await rejection;
  });
});
