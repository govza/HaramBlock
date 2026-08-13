import { DEFAULT_GLOBAL_KEY, DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { BaseRepository } from '@/utils/db/baseRepository';
import { hostSettingsDb, isIncognito } from '@/utils/db/db';
import { getEffectiveHostname, isGlobalPage } from '@/utils/hostnameUtil';
import { normalizeStoredPolicy } from '@/utils/policy';

import type { IHostSettings, PolicyBehavior, PolicyTarget } from '@/utils/types';

const STORAGE_PREFIX = 'hostSettings:';

/**
 * Repository for managing host settings records
 * Uses storage.session in private browsing mode (ephemeral), IndexedDB otherwise
 */
export class HostSettingsRepository extends BaseRepository<IHostSettings, string> {
  private readonly useSessionStorage: boolean;

  constructor(isIncognitoOverride = false) {
    super(hostSettingsDb.hostSettings);
    this.useSessionStorage = isIncognito || isIncognitoOverride;
  }

  // ============ Storage.session methods for private browsing (ephemeral) ============

  private storageKey(hostname: string): string {
    return `${STORAGE_PREFIX}${hostname}`;
  }

  private async storageGet(hostname: string): Promise<IHostSettings | undefined> {
    const key = this.storageKey(hostname);
    const result = await browser.storage.session.get(key);
    const value = result[key];
    if (value && typeof value === 'object' && 'hostname' in value) {
      return value as IHostSettings;
    }
    return undefined;
  }

  private async storagePut(settings: IHostSettings): Promise<void> {
    const key = this.storageKey(settings.hostname);
    await browser.storage.session.set({ [key]: settings });
  }

  private async storageGetAll(): Promise<IHostSettings[]> {
    const all = await browser.storage.session.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(STORAGE_PREFIX))
      .map(([, value]) => value as IHostSettings);
  }

  private async storageDelete(hostname: string): Promise<void> {
    const key = this.storageKey(hostname);
    await browser.storage.session.remove(key);
  }

  // ============ Unified methods that choose storage based on mode ============

  private async get(hostname: string): Promise<IHostSettings | undefined> {
    if (this.useSessionStorage) {
      return this.storageGet(hostname);
    }
    return this.table.get(hostname);
  }

  private async put(settings: IHostSettings): Promise<void> {
    if (this.useSessionStorage) {
      await this.storagePut(settings);
    } else {
      await this.table.put(settings);
    }
  }

  private async remove(hostname: string): Promise<void> {
    if (this.useSessionStorage) {
      await this.storageDelete(hostname);
    } else {
      await this.table.delete(hostname);
    }
  }

  override async findAll(): Promise<IHostSettings[]> {
    const records = this.useSessionStorage ? await this.storageGetAll() : await this.table.toArray();
    return records.map(record => ({ ...record, policy: normalizeStoredPolicy(record.policy) }));
  }

  /**
   * Find host settings by hostname, returns default if not found
   * Uses stored global settings as base for non-global hostnames
   */
  async findByHostname(hostname: string): Promise<IHostSettings> {
    const effectiveHostname = getEffectiveHostname(hostname);
    const isGlobal = isGlobalPage(effectiveHostname);

    // Get the base settings - for non-global hostnames, use stored global settings
    let baseSettings = DEFAULT_HOST_SETTINGS;
    if (!isGlobal) {
      const storedGlobal = await this.get(DEFAULT_GLOBAL_KEY);
      if (storedGlobal) {
        baseSettings = {
          ...DEFAULT_HOST_SETTINGS,
          ...storedGlobal,
          masking: { ...DEFAULT_HOST_SETTINGS.masking, ...storedGlobal.masking },
          quickToggle: { ...DEFAULT_HOST_SETTINGS.quickToggle, ...storedGlobal.quickToggle },
          policy: normalizeStoredPolicy(storedGlobal.policy),
        };
      }
    }

    const stored = await this.get(effectiveHostname);
    return {
      ...baseSettings,
      ...stored,
      masking: { ...baseSettings.masking, ...stored?.masking },
      quickToggle: { ...baseSettings.quickToggle, ...stored?.quickToggle },
      policy: normalizeStoredPolicy(stored?.policy ?? baseSettings.policy),
      hostname: effectiveHostname,
      isGlobal,
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
    await this.put(hostSettings);
    return hostSettings;
  }

  /**
   * Save host settings to database
   * @param settings - Host settings to save
   */
  async saveSettings(settings: IHostSettings): Promise<void> {
    try {
      await this.put(settings);
    } catch (error) {
      throw new Error('Failed to save host settings', { cause: error });
    }
  }

  /**
   * Cycle the policy behavior: process -> whitelist -> blacklist -> process
   * @param hostname - The hostname to toggle policy for
   * @returns Updated host settings
   */
  async togglePolicy(hostname: string): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);

    const behaviorOrder: PolicyBehavior[] = ['process', 'whitelist', 'blacklist'];
    const currentIndex = behaviorOrder.indexOf(settings.policy.behavior);
    const nextBehavior = behaviorOrder[(currentIndex + 1) % behaviorOrder.length];
    if (nextBehavior !== undefined) {
      settings.policy = { ...settings.policy, behavior: nextBehavior };
    }

    await this.saveSettings(settings);
    return settings;
  }

  /**
   * Set the policy behavior for hostname, leaving targets untouched
   * @param hostname - The hostname to update
   * @param behavior - The policy behavior to set
   * @returns Updated host settings
   */
  async setBehavior(hostname: string, behavior: PolicyBehavior): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.policy = { ...settings.policy, behavior };
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
   * Toggle a single media target (image/video) for hostname.
   * Enforces the invariant that at least one target stays enabled — a request that
   * would disable the last enabled target is ignored and settings are returned unchanged.
   * @param hostname - The hostname to update
   * @param target - The media target to toggle
   * @param enabled - Whether the target should be processed
   * @returns Updated host settings
   */
  async setTarget(hostname: string, target: PolicyTarget, enabled: boolean): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    const targets = { ...settings.policy.targets, [target]: enabled };
    if (!Object.values(targets).some(Boolean)) {
      return settings;
    }
    settings.policy = { ...settings.policy, targets };
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

  async setGrayscale(hostname: string, enabled: boolean): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.masking = { ...settings.masking, grayscale: enabled };
    await this.saveSettings(settings);
    return settings;
  }

  async setDark(hostname: string, enabled: boolean): Promise<IHostSettings> {
    const settings = await this.findByHostname(hostname);
    settings.masking = { ...settings.masking, dark: enabled };
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
  override async delete(hostname: string): Promise<void> {
    const effectiveHostname = getEffectiveHostname(hostname);

    // Special case: reset global settings instead of deleting
    if (effectiveHostname === DEFAULT_GLOBAL_KEY) {
      await this.saveSettings(DEFAULT_HOST_SETTINGS);
      return;
    }

    // Regular deletion for non-global hosts
    await this.remove(effectiveHostname);
  }
}

const instances = new Map<boolean, HostSettingsRepository>();

/** Get a cached repository instance - pass true for incognito/private browsing contexts */
export function createHostSettingsRepository(isIncognito = false): HostSettingsRepository {
  let instance = instances.get(isIncognito);
  if (!instance) {
    instance = new HostSettingsRepository(isIncognito);
    instances.set(isIncognito, instance);
  }
  return instance;
}
