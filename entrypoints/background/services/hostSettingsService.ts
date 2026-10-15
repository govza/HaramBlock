import { createHostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { ATTR, getLogger } from '@/utils/telemetry';

import type { IHostSettings } from '@/utils/types';

const log = getLogger('hostSettingsService');

/**
 * Resolves effective per-host settings for the background and memoizes them, so per-frame and
 * per-sample inference does not re-read IndexedDB. Any settings change must call `invalidate()`:
 * host settings inherit from the global row, so one write can change every hostname.
 */
export class HostSettingsService {
  private readonly resolved = new Map<string, Promise<IHostSettings>>();

  async getHostSettings(hostname: string, isIncognito = false): Promise<IHostSettings> {
    if (!hostname) {
      throw new Error('Hostname is required');
    }

    const effectiveHostname = getEffectiveHostname(hostname);
    const cacheKey = `${isIncognito}:${effectiveHostname}`;
    const cached = this.resolved.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = createHostSettingsRepository(isIncognito).findByHostname(effectiveHostname);
    this.resolved.set(cacheKey, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.resolved.get(cacheKey) === pending) {
        this.resolved.delete(cacheKey);
      }
      log.error('host_settings.get_failed', { [ATTR.hostname]: effectiveHostname, error });
      throw error;
    }
  }

  invalidate(): void {
    this.resolved.clear();
  }
}
