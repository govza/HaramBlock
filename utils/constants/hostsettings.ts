import type { IHostSettings } from '@/utils/types';

export const DEFAULT_GLOBAL_KEY = 'global';

export const DEFAULT_HOST_SETTINGS: IHostSettings = {
  hostname: DEFAULT_GLOBAL_KEY,
  masking: { blur: true, grayscale: false, dark: false, blurIntensity: 50, pixelationScale: 50 },
  isGlobal: true,
  outline: 'segment',
  policy: 'process',
  strictness: 0.8,
  minSize: { width: 50, height: 50 },
  quickToggle: { unsafeEnabled: true, safeEnabled: true },
};
