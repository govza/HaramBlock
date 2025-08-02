import { IconService } from '@/entrypoints/background/services/iconService';
import { logger } from '@/utils/logger';

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
    browser.tabs.onUpdated.addListener(
      (
        tabId: number,
        changeInfo: Browser.tabs.TabChangeInfo,
        tab: Browser.tabs.Tab,
      ) => {
        void (async () => {
          if (changeInfo.url || changeInfo.status === 'complete') {
            if (tab.url) {
              await this.iconService.updateIconForUrl(tabId, tab.url);
            }
          }
        })();
      },
    );

    // Handle tab activation to update icon for the active tab
    browser.tabs.onActivated.addListener(
      (activeInfo: Browser.tabs.TabActiveInfo) => {
        void (async () => {
          try {
            const tab = await browser.tabs.get(activeInfo.tabId);
            if (tab.url) {
              await this.iconService.updateIconForUrl(
                activeInfo.tabId,
                tab.url,
              );
            }
          } catch (error) {
            logger
              .withTag('iconEventListener')
              .error('Error handling tab activation:', error);
          }
        })();
      },
    );

    // Runtime event listeners
    browser.runtime.onStartup.addListener(() => {
      void this.iconService.updateIconForActiveTab();
    });
  }
}
