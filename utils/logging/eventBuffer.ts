import { storeWideEvent } from '@/utils/logging/eventStorage';

import type { WideEvent } from '@/utils/logging/types';

export const pushEvent = async (event: WideEvent): Promise<boolean> => {
  if (event.context === 'content') {
    // Content scripts cannot access browser.storage.session directly
    // Use RPC to send event to background for storage
    try {
      const { backgroundRpc } = await import('@/utils/messaging/content');
      await backgroundRpc.storeContentEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  await storeWideEvent(event);
  return true;
};

// Re-export storage functions for convenience
export {
  storeWideEvent,
  mergeContentEvent,
  getEvents,
  clearEvents,
  exportEvents,
  exportEventsAsJson,
} from '@/utils/logging/eventStorage';
