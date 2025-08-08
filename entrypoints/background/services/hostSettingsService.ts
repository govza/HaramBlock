import { HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { logger } from '@/utils/logger';

import type { IHostSettings } from '@/utils/types';

/**
 * HostSettingsService handles business logic for host settings
 * Coordinates between controllers and data layer
 */
export class HostSettingsService {
  private repository: HostSettingsRepository;

  constructor() {
    this.repository = new HostSettingsRepository();
  }

  /**
   * Retrieve host settings for a given hostname
   * @param hostname - The hostname to retrieve settings for
   * @returns Promise resolving to host settings
   */
  async getHostSettings(hostname: string): Promise<IHostSettings> {
    if (!hostname) {
      throw new Error('Hostname is required');
    }

    // Normalize the hostname using centralized logic
    const effectiveHostname = getEffectiveHostname(hostname);

    try {
      return await this.repository.findByHostname(effectiveHostname);
    } catch (error) {
      logger
        .withTag('hostSettingsService')
        .error('Error retrieving host settings for hostname:', effectiveHostname, error);
      throw error;
    }
  }
}
