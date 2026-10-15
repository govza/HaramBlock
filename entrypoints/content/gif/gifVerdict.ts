import type { IGifFramePrediction, IImagePrediction } from '@/utils/types';

/**
 * Everything needed to fold one GIF's sampled frame verdicts into a single image verdict.
 * `fallbackSize` sizes the verdict when no frame prediction arrived (e.g. every frame failed), and
 * `forceBlocked` marks a verdict reached through failure or timeout so it fails closed.
 */
export interface GifVerdictInput {
  src: string;
  hostname: string;
  framePredictions: Iterable<IGifFramePrediction>;
  fallbackSize?: { width: number; height: number };
  forceBlocked: boolean;
  now: number;
}

const busiestFrame = (frames: IGifFramePrediction[]): IGifFramePrediction | undefined =>
  frames.reduce<IGifFramePrediction | undefined>(
    (best, frame) => (frame.predictions.length > (best?.predictions.length ?? 0) ? frame : best),
    undefined,
  );

/**
 * Represents the GIF by its single busiest frame rather than summing detections across frames, so the
 * badge/timing count reflects one frame's worth instead of N copies of the same recurring subject;
 * shouldBlock still trips whenever any frame had a hit.
 */
export const aggregateGifVerdict = (input: GifVerdictInput): IImagePrediction => {
  const frames = Array.from(input.framePredictions).sort((a, b) => a.frameIndex - b.frameIndex);
  const firstFrame = frames[0];
  const { now } = input;

  return {
    src: input.src,
    hostname: input.hostname,
    width: firstFrame?.width ?? input.fallbackSize?.width ?? 0,
    height: firstFrame?.height ?? input.fallbackSize?.height ?? 0,
    predictions: busiestFrame(frames)?.predictions ?? [],
    timestamp: now,
    cacheMetadata: {
      contentType: 'image/gif',
      createdAt: now,
      accessedAt: now,
    },
    maskTransform: firstFrame?.maskTransform ?? { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    processingTime: {
      fetchTime: 0,
      decodeTime: 0,
      queueTime: 0,
      inferenceTime: 0,
      e2eTime: 0,
      backend: 'gif-frame',
    },
    forcedVisibility: input.forceBlocked ? 'blocked' : 'auto',
  };
};
