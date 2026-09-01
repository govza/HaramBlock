import { IconService } from '@/entrypoints/background/services/iconService';
import { getLogger } from '@/utils/telemetry';

const log = getLogger('iconEventListener');

/**
 * IconEventListener handles all browser events related to icon and badge updates.
 * Listens to tab events, runtime events, and other browser events that require icon updates.
 */
export class IconEventListener {
  private readonly iconService: IconService;

  constructor() {
    this.iconService = new IconService();
  }

  public initialize(): void {
    // Update extension icon when a tab's URL changes OR when page status changes (including refresh)
    browser.tabs.onUpdated.addListener((tabId: number, changeInfo, tab) => {
      if (changeInfo.status === 'loading') {
        const action = browser.action ?? browser.browserAction;
        action.setBadgeText({ tabId, text: '' }).catch(() => {});
      }
      if (changeInfo.url || changeInfo.status === 'complete') {
        if (tab.url) {
          this.iconService.updateIconForUrl(tabId, tab.url).catch(error => {
            log.error('icon.update_for_tab_failed', { tabId, error });
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
          log.error('icon.tab_activation_failed', { tabId: activeInfo.tabId, error });
        });
    });

    // Runtime event listeners
    browser.runtime.onStartup.addListener(() => {
      void this.iconService.updateIconForActiveTab();
    });
  }
}
