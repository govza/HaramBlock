import { logger } from '@/utils/logger';

import type { WideEvent, LogExport } from '@/utils/logging/types';

const MAX_EVENTS = 500;
const STORAGE_KEY = 'wideEvents';

const getVersion = (): string => {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
};

// Use browser.storage.session for cross-context access (ephemeral, not persisted to disk)
// Note: Content scripts cannot access storage.session, only background/popup can
const getStorage = () => {
  // session storage is preferred (ephemeral), fall back to local if not available
  return browser.storage.session ?? browser.storage.local;
};

// Store event directly to session storage - called by background
export const storeWideEvent = async (event: WideEvent): Promise<void> => {
  try {
    const storage = getStorage();
    const result = await storage.get(STORAGE_KEY);
    const events: WideEvent[] = (result[STORAGE_KEY] as WideEvent[]) ?? [];

    events.push(event);

    // Keep only last MAX_EVENTS
    while (events.length > MAX_EVENTS) {
      events.shift();
    }

    await storage.set({ [STORAGE_KEY]: events });
  } catch {
    // Silent fail - storage may not be available in all contexts
  }
};

/**
 * Merge content timing into an existing background event.
 * Returns the merged event if successful, null if no matching background event found.
 */
export const mergeContentEvent = async (contentEvent: WideEvent): Promise<WideEvent | null> => {
  try {
    const storage = getStorage();
    const result = await storage.get(STORAGE_KEY);
    const events: WideEvent[] = (result[STORAGE_KEY] as WideEvent[]) ?? [];

    // Find most recent background event with same reqId (search from end)
    const bgIndex = events.findLastIndex(e => e.reqId === contentEvent.reqId && e.context === 'background');

    const bgEvent = events[bgIndex];
    if (bgIndex === -1 || !bgEvent) {
      return null;
    }

    // Merge content fields into background event
    const merged: WideEvent = {
      ...bgEvent,
      sendMs: contentEvent.sendMs,
      waitMs: contentEvent.waitMs,
      styleMs: contentEvent.styleMs,
      overlayType: contentEvent.overlayType,
      detectionsCount: contentEvent.detectionsCount ?? bgEvent.detectionsCount,
      status: contentEvent.status === 'error' ? 'error' : bgEvent.status,
      reason: contentEvent.reason ?? bgEvent.reason,
      stage: contentEvent.stage,
      source: contentEvent.source,
      error: contentEvent.error ?? bgEvent.error,
      // Content-side anchors survive the merge so the full content window can be reconstructed
      contentTotalMs: contentEvent.totalMs,
      contentTimestamp: contentEvent.timestamp,
    };

    events[bgIndex] = merged;
    await storage.set({ [STORAGE_KEY]: events });
    return merged;
  } catch {
    return null;
  }
};

export const getEvents = async (): Promise<WideEvent[]> => {
  try {
    const storage = getStorage();
    const result = await storage.get(STORAGE_KEY);
    const events = (result[STORAGE_KEY] as WideEvent[]) ?? [];
    return events;
  } catch (err) {
    logger.withTag('eventStorage').error('Failed to get events:', err);
    return [];
  }
};

export const clearEvents = async (): Promise<void> => {
  try {
    const storage = getStorage();
    await storage.remove(STORAGE_KEY);
  } catch {
    // Silent fail
  }
};

export const exportEvents = async (): Promise<LogExport> => {
  const events = await getEvents();
  return {
    exportedAt: Date.now(),
    version: getVersion(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    eventCount: events.length,
    events,
  };
};

export const exportEventsAsJson = async (): Promise<string> => {
  const data = await exportEvents();
  return JSON.stringify(data, null, 2);
};
