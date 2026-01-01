import { DEFAULT_GLOBAL_KEY, DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { BaseRepository } from '@/utils/db/baseRepository';
import { hostSettingsDb } from '@/utils/db/db';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';

import type { IHostSettings, OutlineType, HostPolicy, BlurTintType } from '@/utils/types';

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
    return {
      ...DEFAULT_HOST_SETTINGS,
      ...stored,
      masking: { ...DEFAULT_HOST_SETTINGS.masking, ...stored?.masking },
      quickToggle: { ...DEFAULT_HOST_SETTINGS.quickToggle, ...stored?.quickToggle },
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
      ...DEFAULT_HOST_SETTINGS,
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

  async setQuickToggleUnsafe(hostname: string, enabled: boolean): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.quickToggle = { ...settings.quickToggle, unsafeEnabled: enabled };
    await this.saveSettings(settings);
    return settings;
  }

  async setQuickToggleSafe(hostname: string, enabled: boolean): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.quickToggle = { ...settings.quickToggle, safeEnabled: enabled };
    await this.saveSettings(settings);
    return settings;
  }

  async setBlurTint(hostname: string, blurTint: BlurTintType): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.masking = { ...settings.masking, blurTint };
    await this.saveSettings(settings);
    return settings;
  }

  async setBlurIntensity(hostname: string, blurIntensity: number): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.masking = { ...settings.masking, blurIntensity: Math.max(1, Math.min(100, blurIntensity)) };
    await this.saveSettings(settings);
    return settings;
  }

  async setPixelationScale(hostname: string, pixelationScale: number): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.masking = { ...settings.masking, pixelationScale: Math.max(1, Math.min(100, pixelationScale)) };
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
    if (effectiveHostname === DEFAULT_GLOBAL_KEY) {
      await this.saveSettings(DEFAULT_HOST_SETTINGS);
      return;
    }

    // Regular deletion for non-global hosts
    await super.delete(effectiveHostname);
  }
}
