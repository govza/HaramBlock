import { BaseRepository } from '@/utils/db/baseRepository';
import { defaultGlobalKey, defaultHostSettings } from '@/utils/db/constants';
import { hostSettingsDb } from '@/utils/db/db';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';

import type { IHostSettings, OutlineType, HostPolicy } from '@/utils/types';

/**
 * Repository for managing host settings records
 * Provides database operations and business logic for host settings
 */
export class HostSettingsRepository extends BaseRepository<IHostSettings, string> {
  constructor() {
    super(hostSettingsDb.hostSettings);
  }

  /**
   * Find host settings by hostname, returns default if not found
   * @param hostname - The hostname to find settings for
   * @returns Host settings for the hostname
   */
  async findByHostname(hostname: string): Promise<IHostSettings> {
    const effectiveHostname = getEffectiveHostname(hostname);
    const stored = await this.table.get(effectiveHostname);
    return stored
      ? stored
      : {
          ...defaultHostSettings,
          hostname: effectiveHostname,
          isGlobal: isGlobalPage(effectiveHostname),
        };
  }

  /**
   * Create new host settings
   * @param settings - Partial settings with required hostname
   * @returns Created host settings
   */
  async createHostSettings(settings: Partial<IHostSettings> & { hostname: string }): Promise<IHostSettings> {
    const effectiveHostname = getEffectiveHostname(settings.hostname);
    const hostSettings: IHostSettings = {
      ...defaultHostSettings,
      ...settings,
      hostname: effectiveHostname,
      isGlobal: isGlobalPage(effectiveHostname),
    };
    await this.save(hostSettings);
    return hostSettings;
  }

  /**
   * Save host settings to database
   * @param settings - Host settings to save
   */
  async saveSettings(settings: IHostSettings): Promise<void> {
    try {
      await this.table.put(settings);
    } catch (error) {
      throw new Error('Failed to save host settings', { cause: error });
    }
  }

  /**
   * Toggle policy between whitelist -> blacklist -> process -> whitelist
   * @param hostname - The hostname to toggle policy for
   * @returns Updated host settings
   */
  async togglePolicy(hostname: string): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);

    if (settings.policy === 'whitelist') {
      settings.policy = 'blacklist';
    } else if (settings.policy === 'blacklist') {
      settings.policy = 'process';
    } else {
      settings.policy = 'whitelist';
    }

    await this.saveSettings(settings);
    return settings;
  }

  /**
   * Set outline type for hostname
   * @param hostname - The hostname to update
   * @param outlineVariant - The outline type to set
   * @returns Updated host settings
   */
  async setOutline(hostname: string, outlineVariant: OutlineType): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.outline = outlineVariant;
    await this.saveSettings(settings);
    return settings;
  }

  /**
   * Set strictness level for hostname
   * @param hostname - The hostname to update
   * @param strictness - Strictness level (clamped between 0 and 1)
   * @returns Updated host settings
   */
  async setStrictness(hostname: string, strictness: number): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.strictness = Math.max(0, Math.min(1, strictness));
    await this.saveSettings(settings);
    return settings;
  }

  /**
   * Set policy for hostname
   * @param hostname - The hostname to update
   * @param policy - The policy to set
   * @returns Updated host settings
   */
  async setPolicy(hostname: string, policy: HostPolicy): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.policy = policy;
    await this.saveSettings(settings);
    return settings;
  }

  /**
   * Delete host settings by hostname
   * For global settings, resets to default instead of deleting
   * @param hostname - The hostname to delete or reset
   */
  async delete(hostname: string): Promise<void> {
    const effectiveHostname = getEffectiveHostname(hostname);

    // Special case: reset global settings instead of deleting
    if (effectiveHostname === defaultGlobalKey) {
      await this.saveSettings(defaultHostSettings);
      return;
    }

    // Regular deletion for non-global hosts
    await super.delete(effectiveHostname);
  }
}
