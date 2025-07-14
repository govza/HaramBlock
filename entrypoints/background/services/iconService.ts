import type { HostPolicy } from '@/utils/db/hostSettings';
import { HostSettings } from '@/utils/db/hostSettings';
import { getEffectiveHostname, extractHostnameFromUrl } from '@/utils/db/hostnameUtil';

/**
 * IconService handles browser extension icon updates
 * Focused on icon management and rendering logic
 */
export class IconService {
  private readonly iconBasePath = '/icon/';

  private getIconPaths(policy: HostPolicy): Record<string, string> {
    switch (policy) {
      case 'blacklist':
        return {
          '16': `${this.iconBasePath}icon16-blacklist.png`,
          '24': `${this.iconBasePath}icon24-blacklist.png`,
          '32': `${this.iconBasePath}icon32-blacklist.png`,
          '48': `${this.iconBasePath}icon48-blacklist.png`,
          '128': `${this.iconBasePath}icon128-blacklist.png`
        };
      case 'whitelist':
        return {
          '16': `${this.iconBasePath}icon16-whitelist.png`,
          '24': `${this.iconBasePath}icon24-whitelist.png`,
          '32': `${this.iconBasePath}icon32-whitelist.png`,
          '48': `${this.iconBasePath}icon48-whitelist.png`,
          '128': `${this.iconBasePath}icon128-whitelist.png`
        };
      case 'process':
      default:
        return {
          '16': `${this.iconBasePath}16.png`,
          '24': `${this.iconBasePath}24.png`,
          '32': `${this.iconBasePath}32.png`,
          '48': `${this.iconBasePath}48.png`,
          '128': `${this.iconBasePath}128.png`
        };
    }
  }

  /**
   * Update icon for a specific tab and hostname
   */
  async updateIconForTab(tabId: number, hostname: string): Promise<void> {
    // Normalize the hostname using centralized logic
    const effectiveHostname = getEffectiveHostname(hostname);
    
    if (!effectiveHostname) return;
    
    try {
      const hostSettings = await HostSettings.findByHostname(effectiveHostname);
      const iconPaths = this.getIconPaths(hostSettings.policy);
      await browser.action.setIcon({ tabId, path: iconPaths });
    } catch (error) {
      console.error('Error updating toolbar icon for hostname:', effectiveHostname, error);
    }
  }

  /**
   * Update icon for the currently active tab
   */
  async updateIconForActiveTab(): Promise<void> {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      if (activeTab?.url && activeTab.id) {
        const hostname = extractHostnameFromUrl(activeTab.url);
        if (hostname) {
          await this.updateIconForTab(activeTab.id, hostname);
        }
      }
    } catch (error) {
      console.error('Error updating icon for active tab:', error);
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
