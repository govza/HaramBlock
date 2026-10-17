import type { IHostPolicy } from '@/utils/types';

export const routesVideos = (policy: IHostPolicy): boolean =>
  policy.behavior === 'blacklist' || (policy.behavior === 'process' && policy.targets.video);

export const runsVideoInference = (policy: IHostPolicy): boolean =>
  policy.behavior === 'process' && policy.targets.video;
