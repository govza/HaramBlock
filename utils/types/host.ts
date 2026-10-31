export type PolicyBehavior = 'whitelist' | 'blacklist' | 'process';
export type PolicyTarget = 'image' | 'video' | 'gif';

/**
 * How detected regions are painted over once masked.
 */
export interface IMaskingSettings {
  grayscale: boolean;
  dark: boolean;
  blurIntensity: number;
  pixelationScale: number;
}

/**
 * Whether a host is whitelisted, blacklisted or processed (exactly one behavior), and which media types that applies
 * to (each toggled independently).
 */
export interface IHostPolicy {
  behavior: PolicyBehavior;
  targets: Record<PolicyTarget, boolean>;
}

/**
 * Resolved settings of one host, or of the global row it inherits from; what every filtering decision on that host
 * reads.
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
