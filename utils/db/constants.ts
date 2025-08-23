import type { IHostSettings } from '@/utils/types';

export const defaultGlobalKey = 'global';

export const defaultHostSettings: IHostSettings = {
  hostname: defaultGlobalKey,
  masks: ['blur'],
  isGlobal: true,
  outline: 'segment',
  policy: 'process',
  strictness: 0.8,
  minSize: { width: 50, height: 50 },
};
