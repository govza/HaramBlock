export type PolicyBehavior = 'whitelist' | 'blacklist' | 'process';
export type PolicyTarget = 'image' | 'video' | 'gif';

/**
 * How masked regions are painted: grayscale, darkening, blur intensity and pixelation scale.
 */
export interface IMaskingSettings {
  grayscale: boolean;
  dark: boolean;
  blurIntensity: number;
  pixelationScale: number;
}

/**
 * Whether a host is whitelisted, blacklisted or processed, and which media types that applies to.
 */
export interface IHostPolicy {
  /** Single-select: exactly one behavior is active (radio / cycling toggle). */
  behavior: PolicyBehavior;

  /** Multi-select: each target toggles independently (checkbox group). */
  targets: Record<PolicyTarget, boolean>;
}

/**
 * Resolved settings of one host, or of the global row it inherits from: policy, masking, strictness, minimum media
 * size and Quick Toggle visibility.
 */
export interface IHostSettings {
  hostname: string;
  isGlobal: boolean;
  masking: IMaskingSettings;
  policy: IHostPolicy;
  strictness: number;
  minSize: { width: number; height: number };
  quickToggle: { unsafeEnabled: boolean; safeEnabled: boolean };
}
