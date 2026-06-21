export type PolicyBehavior = 'whitelist' | 'blacklist' | 'process';
export type PolicyTarget = 'image' | 'video' | 'gif';
export type OutlineType = 'bbox' | 'segment';

export interface IMaskingSettings {
  grayscale: boolean;
  dark: boolean;
  blurIntensity: number;
  pixelationScale: number;
}

export interface IHostPolicy {
  /** Single-select: exactly one behavior is active (radio / cycling toggle). */
  behavior: PolicyBehavior;
  /** Multi-select: each target toggles independently (checkbox group). */
  targets: Record<PolicyTarget, boolean>;
}

export interface IHostSettings {
  hostname: string;
  isGlobal: boolean;
  masking: IMaskingSettings;
  outline: OutlineType;
  policy: IHostPolicy;
  strictness: number;
  minSize: { width: number; height: number };
  quickToggle: { unsafeEnabled: boolean; safeEnabled: boolean };
}
