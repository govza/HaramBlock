import type { WideEvent, LogExport } from '@/utils/logging/types';

const MAX_EVENTS = 500;
const STORAGE_KEY = 'wideEvents';
const FLUSH_DELAY_MS = 1000;

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

// Writes go through an in-memory buffer with a debounced flush: serializing the
// full 500-entry array through storage IPC on every event is too expensive at
// sample cadence (issue #95). The buffer is seeded from storage once so events
// from a previous service-worker life are preserved.
let buffer: WideEvent[] | null = null;
let bufferLoad: Promise<WideEvent[]> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const loadBuffer = (): Promise<WideEvent[]> => {
  if (buffer) return Promise.resolve(buffer);
  bufferLoad ??= (async () => {
    let stored: WideEvent[] = [];
    try {
      const result = await getStorage().get(STORAGE_KEY);
      stored = (result[STORAGE_KEY] as WideEvent[]) ?? [];
    } catch {
      // Storage may not be available in all contexts
    }
    // clearEvents may have run while the load was in flight; its empty buffer wins
    buffer ??= stored;
    return buffer;
  })();
  return bufferLoad;
};

const flush = async (): Promise<void> => {
  try {
    await getStorage().set({ [STORAGE_KEY]: buffer ?? [] });
  } catch {
    // Silent fail - storage may not be available in all contexts
  }
};

const scheduleFlush = (): void => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
};

export const __resetEventBufferForTests = (): void => {
  buffer = null;
  bufferLoad = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
};

// Store event in the buffer - called by background
export const storeWideEvent = async (event: WideEvent): Promise<void> => {
  const events = await loadBuffer();

  events.push(event);
  while (events.length > MAX_EVENTS) {
    events.shift();
  }

  scheduleFlush();
};

/**
 * Merge content timing into an existing background event.
 * Returns the merged event if successful, null if no matching background event found.
 */
export const mergeContentEvent = async (contentEvent: WideEvent): Promise<WideEvent | null> => {
  const events = await loadBuffer();

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
    error: contentEvent.error ?? bgEvent.error,
  };

  events[bgIndex] = merged;
  scheduleFlush();
  return merged;
};

export const getEvents = async (): Promise<WideEvent[]> => {
  // The background holds the freshest copy in its buffer; other contexts
  // (popup, options) read the flushed snapshot from storage.
  if (buffer) return buffer;
  try {
    const result = await getStorage().get(STORAGE_KEY);
    return (result[STORAGE_KEY] as WideEvent[]) ?? [];
  } catch (err) {
    console.error('[WideEvent] Failed to get events:', err);
    return [];
  }
};

export const clearEvents = async (): Promise<void> => {
  buffer = [];
  bufferLoad = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await getStorage().remove(STORAGE_KEY);
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
