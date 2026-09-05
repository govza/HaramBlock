import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDvrCaptureTap } from '@/entrypoints/content/video/dvr/captureTap';

interface FakeFrame {
  closed: boolean;
  close(): void;
}

function makeFrame(): FakeFrame {
  const frame: FakeFrame = {
    closed: false,
    close: () => {
      frame.closed = true;
    },
  };
  return frame;
}

function makeTrack() {
  return { stop: vi.fn() } as unknown as MediaStreamTrack;
}

function makeVideo(tracks: MediaStreamTrack[], currentTime = 0) {
  return {
    currentTime,
    captureStream: () => ({ getVideoTracks: () => tracks, getTracks: () => tracks }) as unknown as MediaStream,
  } as unknown as HTMLVideoElement;
}

function installProcessor(controllerOut: { controller: ReadableStreamDefaultController<FakeFrame> | null }) {
  vi.stubGlobal(
    'MediaStreamTrackProcessor',
    class {
      readable = new ReadableStream<FakeFrame>({
        start: controller => {
          controllerOut.controller = controller;
        },
      });
    },
  );
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('startDvrCaptureTap', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports no_track_processor when MediaStreamTrackProcessor is unavailable', () => {
    vi.stubGlobal('MediaStreamTrackProcessor', undefined);
    expect(startDvrCaptureTap(makeVideo([makeTrack()]), () => {})).toEqual({
      tap: null,
      reason: 'no_track_processor',
    });
  });

  it('reports the missing piece when the element has no captureStream or no video track', () => {
    installProcessor({ controller: null });
    expect(startDvrCaptureTap({ currentTime: 0 } as unknown as HTMLVideoElement, () => {})).toEqual({
      tap: null,
      reason: 'no_capture_stream',
    });
    expect(startDvrCaptureTap(makeVideo([]), () => {})).toEqual({ tap: null, reason: 'no_video_track' });
  });

  it('reports capture_stream_failed and stays fallback-safe when captureStream throws', () => {
    installProcessor({ controller: null });
    const video = {
      currentTime: 0,
      captureStream: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    } as unknown as HTMLVideoElement;
    expect(startDvrCaptureTap(video, () => {})).toEqual({ tap: null, reason: 'capture_stream_failed' });
  });

  it('delivers every decoded frame keyed by the media clock at delivery time', async () => {
    const out = { controller: null as ReadableStreamDefaultController<FakeFrame> | null };
    installProcessor(out);
    const video = makeVideo([makeTrack()], 1.5);
    const received: Array<{ frame: FakeFrame; mediaTime: number }> = [];
    const { tap } = startDvrCaptureTap(video, (frame, mediaTime) =>
      received.push({ frame: frame as unknown as FakeFrame, mediaTime }),
    );
    expect(tap).not.toBeNull();

    out.controller!.enqueue(makeFrame());
    await flush();
    (video as { currentTime: number }).currentTime = 1.6;
    out.controller!.enqueue(makeFrame());
    await flush();

    expect(received.map(entry => entry.mediaTime)).toEqual([1.5, 1.6]);
    expect(received.every(entry => !entry.frame.closed)).toBe(true);
    tap!.stop();
  });

  it('stop cancels the reader, stops the track, and closes an in-flight frame', async () => {
    const out = { controller: null as ReadableStreamDefaultController<FakeFrame> | null };
    installProcessor(out);
    const stop = vi.fn();
    const track = { stop } as unknown as MediaStreamTrack;
    const received: FakeFrame[] = [];
    const { tap } = startDvrCaptureTap(makeVideo([track]), frame => received.push(frame as unknown as FakeFrame));

    tap!.stop();
    const late = makeFrame();
    try {
      out.controller!.enqueue(late);
    } catch {
      late.close();
    }
    await flush();

    expect(stop).toHaveBeenCalled();
    expect(received).toHaveLength(0);
    expect(late.closed).toBe(true);
  });
});
