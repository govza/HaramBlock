/**
 * rVFC misses frames on 60 fps sources (~43/60 observed). Frames are keyed by
 * `video.currentTime` at delivery: captureStream timestamps live in the capture
 * clock, not the media timeline.
 */

import { getLogger } from '@/utils/telemetry';

const log = getLogger('dvrCaptureTap');

const TAP_BUFFER_FRAMES = 8;

interface VideoFrameReadable {
  readable: ReadableStream<VideoFrame>;
}

declare global {
  interface HTMLVideoElement {
    captureStream?: () => MediaStream;
  }
  var MediaStreamTrackProcessor:
    (new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => VideoFrameReadable) | undefined;
}

export interface DvrCaptureTap {
  stop(): void;
}

export function startDvrCaptureTap(
  video: HTMLVideoElement,
  onFrame: (frame: VideoFrame, mediaTime: number) => void,
): DvrCaptureTap | null {
  if (typeof MediaStreamTrackProcessor === 'undefined' || typeof video.captureStream !== 'function') return null;
  let stream: MediaStream;
  try {
    stream = video.captureStream();
  } catch (error) {
    log.debug('capture_tap.capture_stream.unavailable', { error });
    return null;
  }
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  let reader: ReadableStreamDefaultReader<VideoFrame>;
  try {
    // The processor's default single-frame queue silently drops a frame
    // whenever the main thread is busy at delivery (~8 fps lost at 60 fps).
    reader = new MediaStreamTrackProcessor({ track, maxBufferSize: TAP_BUFFER_FRAMES }).readable.getReader();
  } catch (error) {
    log.debug('capture_tap.unavailable', { error });
    track.stop();
    return null;
  }
  let stopped = false;
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped || !value) {
          value?.close();
          break;
        }
        onFrame(value, video.currentTime);
      }
    } catch (error) {
      log.debug('capture_tap.ended', { error });
    }
  })();
  return {
    stop: () => {
      stopped = true;
      reader.cancel().catch(() => {});
      for (const streamTrack of stream.getTracks()) streamTrack.stop();
    },
  };
}
