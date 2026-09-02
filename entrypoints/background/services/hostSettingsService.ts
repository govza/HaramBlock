import { createHostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { ATTR, getLogger } from '@/utils/telemetry';

import type { IHostSettings } from '@/utils/types';

const log = getLogger('hostSettingsService');

/**
 * HostSettingsService handles business logic for host settings
 * Coordinates between controllers and data layer
 */
export class HostSettingsService {
  async getHostSettings(hostname: string, isIncognito = false): Promise<IHostSettings> {
    if (!hostname) {
      throw new Error('Hostname is required');
    }

    const effectiveHostname = getEffectiveHostname(hostname);

    try {
      const repository = createHostSettingsRepository(isIncognito);
      return await repository.findByHostname(effectiveHostname);
    } catch (error) {
      log.error('host_settings.get_failed', { [ATTR.hostname]: effectiveHostname, error });
      throw error;
    }
  }
}
