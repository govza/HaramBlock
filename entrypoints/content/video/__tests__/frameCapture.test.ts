import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CaptureStageTimeoutError,
  ensureCorsSafeSource,
  waitForVideoFrameAt,
} from '@/entrypoints/content/video/frameCapture';

class FakeVideo extends EventTarget {
  currentTime = 0;
  readyState = 0;
  seeking = true;
}

class FakeCorsVideo extends EventTarget {
  currentTime = 0;
  readyState = 0;
  seeking = false;
  videoHeight = 0;
  muted = false;
  playsInline = false;
  preload = '';
  src = '';
  loop = false;
  playbackRate = 1;
  onloadeddata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();

  setAttribute(): void {}
  removeAttribute(): void {}
  load(): void {}
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

  it('keeps a successful CORS clone decoding alongside a playing source', async () => {
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    const clone = new FakeCorsVideo();
    vi.stubGlobal('document', { createElement: vi.fn(() => clone) });
    const source = {
      currentSrc: 'https://media.example/video.mp4',
      src: '',
      srcObject: null,
      crossOrigin: null,
      currentTime: 4.25,
      paused: false,
      ended: false,
      loop: true,
      playbackRate: 1.5,
    } as unknown as HTMLVideoElement;

    const pending = ensureCorsSafeSource(source, 4.25);
    clone.readyState = 2;
    clone.videoHeight = 360;
    clone.onloadeddata?.();

    await expect(pending).resolves.toBe(clone);
    expect(clone.preload).toBe('auto');
    expect(clone.loop).toBe(true);
    expect(clone.playbackRate).toBe(1.5);
    expect(clone.play).toHaveBeenCalledOnce();
  });

  it('concurrent callers share one clone instead of racing duplicate creations', async () => {
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    const clone = new FakeCorsVideo();
    const createElement = vi.fn(() => clone);
    vi.stubGlobal('document', { createElement });
    const source = {
      currentSrc: 'https://media.example/shared.mp4',
      src: '',
      srcObject: null,
      crossOrigin: null,
      currentTime: 4.25,
      paused: true,
      ended: false,
      loop: false,
      playbackRate: 1,
    } as unknown as HTMLVideoElement;

    const first = ensureCorsSafeSource(source, 4.25);
    const second = ensureCorsSafeSource(source, 4.25);
    clone.readyState = 2;
    clone.videoHeight = 360;
    clone.onloadeddata?.();

    await expect(first).resolves.toBe(clone);
    await expect(second).resolves.toBe(clone);
    expect(createElement).toHaveBeenCalledOnce();
  });
});
