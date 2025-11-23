import { logger } from '@/utils/logger';

/**
 * TabEventListener handles tab activation events and notifies inference orchestration
 */
export class TabEventListener {
  private activeTabId: number | null = null;
  private onTabActivatedCallback: ((tabId: number) => void) | null = null;

  public initialize(): void {
    // Initialize with current active tab
    void browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]?.id && this.activeTabId === null) {
        this.activeTabId = tabs[0].id;
        logger.withTag('tabEventListener').debug(`Initialized with active tab: ${this.activeTabId}`);
      }
    });

    // Listen for tab activation changes
    browser.tabs.onActivated.addListener(activeInfo => {
      const previousActiveTabId = this.activeTabId;
      this.activeTabId = activeInfo.tabId;

      logger.withTag('tabEventListener').debug(`Tab activated: ${activeInfo.tabId} (previous: ${previousActiveTabId})`);

      // Notify callback if registered
      if (this.onTabActivatedCallback && previousActiveTabId !== this.activeTabId) {
        this.onTabActivatedCallback(this.activeTabId);
      }
    });
  }

  public setOnTabActivatedCallback(callback: (tabId: number) => void): void {
    this.onTabActivatedCallback = callback;
  }

  public getActiveTabId(): number | null {
    return this.activeTabId;
  }
}
