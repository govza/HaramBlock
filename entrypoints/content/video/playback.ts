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
      // Map FrameIntent to requestVideoFrameInference params
      const frameIndex = intent.kind === 'thumbnail' ? -1 : intent.frameIndex;
      const timestampSec = intent.kind === 'thumbnail' ? 0 : intent.timestampSec;

      await requestVideoFrameInference({
        video: vid,
        bitmap,
        hostname,
        sessionId,
        frameIndex,
        timestampSec,
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
