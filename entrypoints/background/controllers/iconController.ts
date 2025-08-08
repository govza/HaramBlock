import { type BridgeMessage } from 'webext-bridge';
import { onMessage } from 'webext-bridge/background';

import { IconService } from '@/entrypoints/background/services/iconService';
import { logger } from '@/utils/logger';

/**
 * IconController handles incoming messages related to icon updates
 * Coordinates between messaging layer and icon service
 */
export class IconController {
  private readonly iconService: IconService;

  constructor() {
    this.iconService = new IconService();
  }

  /**
   * Initialize message listeners (API)
   */
  public initialize(): void {
    onMessage('UPDATE_ICON', this.updateIcon.bind(this));
  }

  /**
   * Handle icon update request
   * @param message - The incoming message containing the icon update request
   * @returns Promise resolving when icon is updated
   */
  public async updateIcon(message: BridgeMessage<{ hostname: string }>): Promise<void> {
    const { hostname } = message.data;
    const tabId = message.sender.tabId || null;

    if (!hostname) {
      throw new Error('Hostname is required for icon update');
    }

    try {
      if (tabId) {
        // Update icon for specific tab
        await this.iconService.updateIconForTab(tabId, hostname);
      } else {
        // Update icon for active tab - the IconService will handle hostname normalization
        await this.iconService.updateIconForActiveTabWithHostname(hostname);
      }
    } catch (error) {
      logger.withTag('iconController').error('Error updating icon for hostname:', hostname, error);
      throw error;
    }
  }
}
