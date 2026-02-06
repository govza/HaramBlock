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
    // Update extension icon when a tab's URL changes OR when page status changes (including refresh)
    browser.tabs.onUpdated.addListener((tabId: number, changeInfo, tab) => {
      if (changeInfo.url || changeInfo.status === 'complete') {
        if (tab.url) {
          this.iconService.updateIconForUrl(tabId, tab.url).catch(error => {
            logger.withTag('iconEventListener').error('Error updating icon for tab:', error);
          });
        }
      }
    });
    // Update extension icon when a tab is activated
    browser.tabs.onActivated.addListener(activeInfo => {
      browser.tabs
        .get(activeInfo.tabId)
        .then(tab => {
          if (tab.url) {
            return this.iconService.updateIconForUrl(activeInfo.tabId, tab.url);
          }
          return Promise.resolve();
        })
        .catch(error => {
          logger.withTag('iconEventListener').error('Error handling tab activation:', error);
        });
    });
    // Runtime event listeners
    browser.runtime.onStartup.addListener(() => {
      void this.iconService.updateIconForActiveTab();
    });
  }
}
