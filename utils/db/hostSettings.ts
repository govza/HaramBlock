import { hostSettingsDb } from "./db";

export interface IHostSettings {
  hostname: string;
  isGlobal: boolean;
  masks: MaskType[];
  outline: OutlineType;
  policy: HostPolicy;
  strictness: number;
}

export type HostPolicy = 'whitelist' | 'blacklist' | 'process';
export type MaskType = 'blur' | 'pixelate';
export type OutlineType = 'bbox' | 'segment';

export const defaultGlobalKey = 'global';

export const defaultHostSettings: IHostSettings = {
    hostname: defaultGlobalKey,
    masks: ['blur'],
    isGlobal: true,
    outline: 'segment',
    policy: 'process',
    strictness: 0.8,
};

export class HostSettings implements IHostSettings {
  hostname: string;
  isGlobal: boolean;
  masks: MaskType[];
  outline: OutlineType;
  policy: HostPolicy;
  strictness: number;

  constructor(settings: IHostSettings) {
    this.hostname = settings.hostname;
    this.isGlobal = settings.isGlobal ?? false;
    this.masks = settings.masks;
    this.outline = settings.outline;
    this.policy = settings.policy;
    this.strictness = settings.strictness;
  }

  async togglePolicy(): Promise<void> {
    this.policy = this.policy === 'whitelist' ? 'blacklist' : this.policy === 'blacklist' ? 'process' : 'whitelist';
    await this.save();
  }

  async setOutline(outlineVariant: OutlineType): Promise<void> {
    this.outline = outlineVariant;
    await this.save();
  }

  async setMask(maskArray: MaskType[]): Promise<void> {
    this.masks = maskArray;
    await this.save();
  }

  async setStrictness(strictness: number): Promise<void> {
    this.strictness = Math.max(0, Math.min(1, strictness));
    await this.save();
  }

  async save(): Promise<void> {
    try {
      await hostSettingsDb.hostSettings.put(this.serialize());
    } catch (error) {
      throw new Error('Failed to save host settings');
    }
  }

  serialize(): IHostSettings {
    return {
      hostname: this.hostname,
      isGlobal: this.isGlobal,
      masks: this.masks,
      outline: this.outline,
      policy: this.policy,
      strictness: this.strictness,
    };
  }

  static async load(hostname: string): Promise<HostSettings> {
    if (!hostname || this.globalPages.includes(hostname)) {
      hostname = defaultGlobalKey;
    }    
    const stored = await hostSettingsDb.hostSettings.get(hostname);
    return stored ? new HostSettings(stored) : new HostSettings({
      ...defaultHostSettings,
      hostname: hostname,
      isGlobal: hostname === defaultGlobalKey,
    });
  }

  static globalPages = ['newtab', 'extensions', 'downloads', 'bookmarks', 'history', 'settings'];
}
