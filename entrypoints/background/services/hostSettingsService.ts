import { HostSettings, IHostSettings } from '@/utils/db/hostSettings';
import { logger } from '@/utils/logger';

/**
 * HostSettingsService handles business logic for host settings
 * Coordinates between controllers and data layer
 */
export class HostSettingsService {
  /**
   * Retrieve host settings for a given hostname
   * @param hostname - The hostname to retrieve settings for
   * @returns Promise resolving to host settings
   */
  async getHostSettings(hostname: string): Promise<IHostSettings> {
    if (!hostname) {
      throw new Error('Hostname is required');
    }

    try {
      return await HostSettings.findByHostname(hostname);
    } catch (error) {
      logger.withTag('hostSettingsService').error('Error retrieving host settings for hostname:', hostname, error);
      throw error;
    }
  }
}
