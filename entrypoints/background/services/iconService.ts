import { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import { extractHostnameFromUrl } from '@/utils/hostnameUtil';
import { logger } from '@/utils/logger';

import type { HostPolicy } from '@/utils/types';

/**
 * IconService handles browser extension icon updates
 * Focused on icon management and rendering logic
 */
export class IconService {
  private readonly iconBasePath = '/icon/';
  private hostSettingService: HostSettingsService;

  constructor() {
    this.hostSettingService = new HostSettingsService();
  }

  private getIconPaths(policy: HostPolicy): Record<string, string> {
    switch (policy) {
      case 'blacklist':
        return {
          '16': `${this.iconBasePath}icon16-blacklist.png`,
          '24': `${this.iconBasePath}icon24-blacklist.png`,
          '32': `${this.iconBasePath}icon32-blacklist.png`,
          '48': `${this.iconBasePath}icon48-blacklist.png`,
          '128': `${this.iconBasePath}icon128-blacklist.png`,
        };
      case 'whitelist':
        return {
          '16': `${this.iconBasePath}icon16-whitelist.png`,
          '24': `${this.iconBasePath}icon24-whitelist.png`,
          '32': `${this.iconBasePath}icon32-whitelist.png`,
          '48': `${this.iconBasePath}icon48-whitelist.png`,
          '128': `${this.iconBasePath}icon128-whitelist.png`,
        };
      case 'process':
      default:
        return {
          '16': `${this.iconBasePath}16.png`,
          '24': `${this.iconBasePath}24.png`,
          '32': `${this.iconBasePath}32.png`,
          '48': `${this.iconBasePath}48.png`,
          '128': `${this.iconBasePath}128.png`,
        };
    }
  }

  /**
   * Update icon for a specific tab and hostname
   */
  async updateIconForTab(tabId: number, hostname: string): Promise<void> {
    try {
      const hostSettings =
        await this.hostSettingService.getHostSettings(hostname);
      const iconPaths = this.getIconPaths(hostSettings.policy);
      await browser.action.setIcon({ tabId, path: iconPaths });
    } catch (error) {
      logger
        .withTag('iconService')
        .error('Error updating toolbar icon for hostname:', hostname, error);
    }
  }

  /**
   * Update icon for the currently active tab
   */
  async updateIconForActiveTab(): Promise<void> {
    try {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      const activeTab = tabs[0];
      if (activeTab?.url && activeTab.id) {
        const hostname = extractHostnameFromUrl(activeTab.url);
        if (hostname) {
          await this.updateIconForTab(activeTab.id, hostname);
        }
      }
    } catch (error) {
      logger
        .withTag('iconService')
        .error('Error updating icon for active tab:', error);
    }
  }

  /**
   * Update icon for the currently active tab using a specific hostname
   * This is useful for global pages where the hostname should be overridden
   */
  async updateIconForActiveTabWithHostname(hostname: string): Promise<void> {
    try {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      const activeTab = tabs[0];

      if (activeTab?.id) {
        await this.updateIconForTab(activeTab.id, hostname);
      }
    } catch (error) {
      logger
        .withTag('iconService')
        .error(
          'Error updating icon for active tab with hostname:',
          hostname,
          error,
        );
    }
  }

  /**
   * Update icon for a specific tab using URL
   */
  async updateIconForUrl(tabId: number, url: string): Promise<void> {
    const hostname = extractHostnameFromUrl(url);
    if (hostname) {
      await this.updateIconForTab(tabId, hostname);
    }
  }
}
