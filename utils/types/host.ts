export type HostPolicy = 'whitelist' | 'blacklist' | 'process';
export type OutlineType = 'bbox' | 'segment';
export type BlurTintType = 'none' | 'grayscale' | 'dark';

export interface IMaskingSettings {
  blur: boolean;
  blurTint: BlurTintType;
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
