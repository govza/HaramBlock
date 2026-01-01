export type HostPolicy = 'whitelist' | 'blacklist' | 'process';
export type OutlineType = 'bbox' | 'segment';

export interface IMaskingSettings {
  blur: boolean;
  grayscale: boolean;
  dark: boolean;
  blurIntensity: number;
  pixelationScale: number;
}

export interface IHostSettings {
  hostname: string;
  isGlobal: boolean;
  masking: IMaskingSettings;
  outline: OutlineType;
  policy: HostPolicy;
  strictness: number;
  minSize: { width: number; height: number };
  quickToggle: { unsafeEnabled: boolean; safeEnabled: boolean };
}
