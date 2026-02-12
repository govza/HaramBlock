import { createHostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { extractHostnameFromUrl } from '@/utils/hostnameUtil';
import { getIconPaths } from '@/utils/icons';
import { logger } from '@/utils/logger';

/**
 * IconService handles browser extension icon and badge updates.
 * Automatically detects private/incognito mode from tab context.
 */
export class IconService {
  // Update icon for a specific tab given its hostname. Used by RPC handlers via RpcContext.
  async updateIconForTab(tabId: number, hostname: string): Promise<void> {
    try {
      const tab = await browser.tabs.get(tabId);
      const repository = createHostSettingsRepository(tab.incognito);
      const hostSettings = await repository.findByHostname(hostname);
      const iconPaths = getIconPaths(hostSettings.policy);
      await (browser.action ?? browser.browserAction).setIcon({ tabId, path: iconPaths });
    } catch (error) {
      logger.withTag('iconService').error('Error updating toolbar icon for hostname:', hostname, error);
    }
  }

  // Update icon for the currently active tab. Used on extension install/update.
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
      logger.withTag('iconService').error('Error updating icon for active tab:', error);
    }
  }

  // Update icon for a tab by extracting hostname from its URL. Used by tab event listeners.
  async updateIconForUrl(tabId: number, url: string): Promise<void> {
    const hostname = extractHostnameFromUrl(url);
    if (hostname) {
      await this.updateIconForTab(tabId, hostname);
    }
  }

  // Update badge text for a specific tab. Shows count if > 0, otherwise clears badge.
  async updateBadgeForTab(tabId: number, count: number): Promise<void> {
    try {
      const action = browser.action ?? browser.browserAction;
      await action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
      await action.setBadgeBackgroundColor({ tabId, color: '#666' });
    } catch (error) {
      logger.withTag('iconService').error('Error updating badge for tab:', error);
    }
  }
}
