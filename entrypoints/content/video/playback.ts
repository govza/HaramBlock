import { requestVideoFrameInference } from '@/entrypoints/content/communication/sender';
import { VideoFrameProcessor } from '@/entrypoints/content/video/VideoFrameProcessor';
import { logger } from '@/utils/logger';

import type { VideoFrameLoopConfig } from '@/utils/constants/video';
import type { IHostSettings } from '@/utils/types';

type FrameIntent = { kind: 'thumbnail' } | { kind: 'frame'; frameIndex: number; timestampSec: number };

const playbackProcessors = new WeakMap<HTMLVideoElement, VideoFrameProcessor>();

export function handleVideoPlayback(
  video: HTMLVideoElement,
  hostSettings: IHostSettings,
  config: VideoFrameLoopConfig,
): void {
  let processor = playbackProcessors.get(video);

  logger.withTag('playback').debug('Ensuring video playback processing', { src: video.currentSrc || video.src });

  if (!processor) {
    const sendSample = async (
      vid: HTMLVideoElement,
      bitmap: ImageBitmap,
      hostname: string,
      intent: FrameIntent,
      sessionId: string,
    ) => {
      const videoUrl = vid.currentSrc || vid.src;
      if (!videoUrl) throw new Error('Video element is missing src');

      const width = vid.videoWidth || vid.clientWidth || bitmap.width;
      const height = vid.videoHeight || vid.clientHeight || bitmap.height;

      if (width === 0 || height === 0) {
        throw new Error('Cannot send video frame with zero dimensions');
      }

      await requestVideoFrameInference({
        hostname,
        // For high-performance channel path, we don't need a blob URL.
        // Pass an empty string; the sender will only create a blob for the fallback path.
        frameSrc: '',
        videoUrl,
        bitmap,
        width,
        height,
        frameIndex: intent.kind === 'thumbnail' ? -1 : intent.frameIndex,
        timestamp: intent.kind === 'thumbnail' ? 0 : intent.timestampSec,
        sessionId,
      });
    };

    processor = new VideoFrameProcessor(video, hostSettings.hostname, config, sendSample);
    playbackProcessors.set(video, processor);
    processor.install();
  } else {
    processor.updateHostname(hostSettings.hostname);
    processor.install();
  }

  processor.start();
}

export function releaseVideoPlayback(video: HTMLVideoElement): void {
  const processor = playbackProcessors.get(video);
  if (!processor) return;
  processor.dispose();
  playbackProcessors.delete(video);
}
