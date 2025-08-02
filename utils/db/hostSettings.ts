import { defaultHostSettings } from '@/utils/db/constants';
import { hostSettingsDb } from '@/utils/db/db';
import { getEffectiveHostname, isGlobalPage } from '@/utils/db/hostnameUtil';

import type {
  IHostSettings,
  MaskType,
  OutlineType,
  HostPolicy,
} from '@/utils/types';

/**
 * HostSettings - Data model and repository for host settings
 * Combines entity model with data access methods
 * Acts as both ActiveRecord pattern and repository for host settings data
 */
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
    if (this.policy === 'whitelist') {
      this.policy = 'blacklist';
    } else if (this.policy === 'blacklist') {
      this.policy = 'process';
    } else {
      this.policy = 'whitelist';
    }
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
      throw new Error('Failed to save host settings', { cause: error });
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

  static async findByHostname(hostname: string): Promise<HostSettings> {
    const effectiveHostname = getEffectiveHostname(hostname);
    const stored = await hostSettingsDb.hostSettings.get(effectiveHostname);
    return stored
      ? new HostSettings(stored)
      : new HostSettings({
          ...defaultHostSettings,
          hostname: effectiveHostname,
          isGlobal: isGlobalPage(effectiveHostname),
        });
  }

  static async create(
    settings: Partial<IHostSettings> & { hostname: string },
  ): Promise<HostSettings> {
    const effectiveHostname = getEffectiveHostname(settings.hostname);
    const hostSettings = new HostSettings({
      ...defaultHostSettings,
      ...settings,
      hostname: effectiveHostname,
      isGlobal: isGlobalPage(effectiveHostname),
    });
    await hostSettings.save();
    return hostSettings;
  }
}
