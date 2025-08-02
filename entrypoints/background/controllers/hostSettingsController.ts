import { onMessage } from 'webext-bridge/background';

import { type HostSettingsService } from '@/entrypoints/background/services';
import { type IHostSettings } from '@/utils/types';

/**
 * HostSettingsController handles incoming messages related to host settings
 * Coordinates between messaging layer and business services
 */
export class HostSettingsController {
  private readonly hostSettingsService: HostSettingsService;

  constructor(hostSettingsService: HostSettingsService) {
    this.hostSettingsService = hostSettingsService;
  }

  /**
   * Initialize message listeners (API)
   */
  public initialize(): void {
    onMessage('GET_HOST_SETTINGS', this.getHostSettings.bind(this));
  }

  /**
   * Handle get host settings request
   * @param message - The incoming message containing the hostname
   * @returns Promise resolving to the host settings
   */
  public async getHostSettings(message: {
    data: { hostname: string };
  }): Promise<IHostSettings> {
    const { hostname } = message.data;
    return this.hostSettingsService.getHostSettings(hostname);
  }
}
