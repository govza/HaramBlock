/**
 * Shared inference queue tiers. Higher values run first at the next queue or
 * dynamic-batch boundary; an inference run already in progress is not preempted.
 */
export const INFERENCE_PRIORITY = {
  liveFrame: 40,
  visibleImage: 30,
  lookaheadUrgent: 25,
  videoThumbnail: 20,
  videoFrame: 10,
  offscreenImage: 0,
} as const;
