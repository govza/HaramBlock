import type { IHostPolicy } from '@/utils/types';

/**
 * Whether discovered videos enter the video path at all (attachment, blurs,
 * discovery hiding, blacklist styling). When the platform cannot capture video
 * frames the flag is false and videos are left native - blacklist included,
 * since styling without analysis would still break playback UX (ADR 0003).
 */
export const routesVideos = (policy: IHostPolicy, videoProcessingAvailable: boolean): boolean =>
  videoProcessingAvailable &&
  (policy.behavior === 'blacklist' || (policy.behavior === 'process' && policy.targets.video));

export const runsVideoInference = (policy: IHostPolicy, videoProcessingAvailable: boolean): boolean =>
  videoProcessingAvailable && policy.behavior === 'process' && policy.targets.video;
