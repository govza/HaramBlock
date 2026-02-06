import { createHostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { logger } from '@/utils/logger';

import type { IHostSettings } from '@/utils/types';

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
      logger
        .withTag('hostSettingsService')
        .error('Error retrieving host settings for hostname:', effectiveHostname, error);
      throw error;
    }
  }
}
