import { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import { extractHostnameFromUrl } from '@/utils/hostnameUtil';
import { getIconPaths } from '@/utils/icons';
import { logger } from '@/utils/logger';

/**
 * IconService handles browser extension icon updates
 * Focused on icon management and rendering logic
 */
export class IconService {
  private hostSettingService: HostSettingsService;

  constructor() {
    this.hostSettingService = new HostSettingsService();
  }

  /**
   * Update icon for a specific tab and hostname
   */
  async updateIconForTab(tabId: number, hostname: string): Promise<void> {
    try {
      const hostSettings = await this.hostSettingService.getHostSettings(hostname);
      const iconPaths = getIconPaths(hostSettings.policy);
      await (browser.action ?? browser.browserAction).setIcon({ tabId, path: iconPaths });
    } catch (error) {
      logger.withTag('iconService').error('Error updating toolbar icon for hostname:', hostname, error);
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
      logger.withTag('iconService').error('Error updating icon for active tab:', error);
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
      logger.withTag('iconService').error('Error updating icon for active tab with hostname:', hostname, error);
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
