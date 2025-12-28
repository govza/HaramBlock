export type HostPolicy = 'whitelist' | 'blacklist' | 'process';
export type OutlineType = 'bbox' | 'segment';

export interface IHostSettings {
  hostname: string;
  isGlobal: boolean;
  masking: { blur: boolean };
  outline: OutlineType;
  policy: HostPolicy;
  strictness: number;
  minSize: { width: number; height: number };
}
