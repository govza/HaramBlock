import { IconService } from '@/entrypoints/background/services/iconService';

/**
 * IconEventListener handles all browser events related to icon updates
 * Listens to tab events, runtime events, and other browser events that require icon updates
 */
export class IconEventListener {
  private readonly iconService: IconService;

  constructor() {
    this.iconService = new IconService();
  }

  public initialize(): void {
    
    // Tab event listeners
    // Update extension icon when a tab's URL changes OR when page status changes (including refresh)
    browser.tabs.onUpdated.addListener(async (tabId: number, changeInfo: Browser.tabs.TabChangeInfo, tab: Browser.tabs.Tab) => {
      if (changeInfo.url || changeInfo.status === 'complete') {
        if (tab.url) {
          await this.iconService.updateIconForUrl(tabId, tab.url);
        }
      }
    });

    // Handle tab activation to update icon for the active tab
    browser.tabs.onActivated.addListener(async (activeInfo: Browser.tabs.TabActiveInfo) => {
      try {
        const tab = await browser.tabs.get(activeInfo.tabId);
        if (tab.url) {
          await this.iconService.updateIconForUrl(activeInfo.tabId, tab.url);
        }
      } catch (error) {
        console.error('Error handling tab activation:', error);
      }
    });

    // Runtime event listeners
    browser.runtime.onStartup.addListener(async () => {
      await this.iconService.updateIconForActiveTab();
    });
  }
}
