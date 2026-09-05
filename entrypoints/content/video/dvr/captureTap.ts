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

export type DvrTapUnavailableReason =
  'no_track_processor' | 'no_capture_stream' | 'capture_stream_failed' | 'no_video_track' | 'processor_failed';

export type DvrCaptureTapResult = { tap: DvrCaptureTap; reason: null } | { tap: null; reason: DvrTapUnavailableReason };

const unavailable = (reason: DvrTapUnavailableReason): DvrCaptureTapResult => ({ tap: null, reason });

export function startDvrCaptureTap(
  video: HTMLVideoElement,
  onFrame: (frame: VideoFrame, mediaTime: number) => void,
): DvrCaptureTapResult {
  if (typeof MediaStreamTrackProcessor === 'undefined') return unavailable('no_track_processor');
  if (typeof video.captureStream !== 'function') return unavailable('no_capture_stream');
  let stream: MediaStream;
  try {
    stream = video.captureStream();
  } catch (error) {
    log.debug('capture_tap.capture_stream.unavailable', { error });
    return unavailable('capture_stream_failed');
  }
  const track = stream.getVideoTracks()[0];
  if (!track) return unavailable('no_video_track');
  let reader: ReadableStreamDefaultReader<VideoFrame>;
  try {
    // The processor's default single-frame queue silently drops a frame
    // whenever the main thread is busy at delivery (~8 fps lost at 60 fps).
    reader = new MediaStreamTrackProcessor({ track, maxBufferSize: TAP_BUFFER_FRAMES }).readable.getReader();
  } catch (error) {
    log.debug('capture_tap.unavailable', { error });
    track.stop();
    return unavailable('processor_failed');
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
    tap: {
      stop: () => {
        stopped = true;
        reader.cancel().catch(() => {});
        for (const streamTrack of stream.getTracks()) streamTrack.stop();
      },
    },
    reason: null,
  };
}
