/**
 * rVFC misses frames on 60 fps sources (~43/60 observed), so the tap reads
 * every decoded frame off the track processor instead. Frames are keyed by
 * `video.currentTime` read at delivery — captureStream frame timestamps live
 * in the capture clock, not the media timeline. A cross-origin source yields
 * a muted track that simply delivers no frames; rVFC stays the fallback.
 */

import { logger } from '@/utils/logger';

const log = logger.withTag('dvrCaptureTap');

interface VideoFrameReadable {
  readable: ReadableStream<VideoFrame>;
}

declare global {
  interface HTMLVideoElement {
    captureStream?: () => MediaStream;
  }
  var MediaStreamTrackProcessor: (new (init: { track: MediaStreamTrack }) => VideoFrameReadable) | undefined;
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
    log.debug('captureStream unavailable:', error);
    return null;
  }
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  let reader: ReadableStreamDefaultReader<VideoFrame>;
  try {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  } catch (error) {
    log.debug('Capture tap unavailable:', error);
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
      log.debug('Capture tap ended:', error);
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
