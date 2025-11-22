import { type BridgeMessage } from 'webext-bridge';
import { onMessage } from 'webext-bridge/background';

import { logger } from '@/utils/logger';

/**
 * GetCurrentTabIdController handles requests for current tab ID
 * This properly retrieves the tab ID from the background context where browser.tabs API is available
 */
export class GetCurrentTabIdController {
  /**
   * Initialize message listeners (API)
   */
  public initialize(): void {
    onMessage('GET_CURRENT_TAB_ID', this.getCurrentTabId.bind(this));
  }

  /**
   * Handle GET_CURRENT_TAB_ID request
   * @param message - The incoming message requesting the current tab ID
   * @returns Promise resolving to the current tab ID
   */
  public getCurrentTabId(message: BridgeMessage<string>): number {
    const { tabId } = message.sender;

    if (tabId == null) {
      logger.withTag('getCurrentTabIdController').error('Tab ID not available in message sender');
      throw new Error('Failed to get current tab ID from message sender');
    }

    logger.withTag('getCurrentTabIdController').debug('Retrieved tab ID:', tabId);
    return tabId;
  }
}
