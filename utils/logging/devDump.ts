import { getEvents } from '@/utils/logging/eventStorage';

/**
 * Dev-only: exposes `globalThis.__hbDumpEvents(n)` on extension pages.
 *
 * MV3 service-worker console output cannot be read through the Playwright MCP
 * (`browser_console_messages` only sees page consoles), but extension pages share the
 * wide-event buffer in `browser.storage.session`. Automation can therefore evaluate
 * `__hbDumpEvents(50)` on `chrome-extension://<id>/popup.html` to get ground truth
 * about background-side processing as a single JSON string.
 */
export const installDevDumpHook = (): void => {
  if (!import.meta.env.DEV) return;
  (globalThis as Record<string, unknown>).__hbDumpEvents = async (n = 50): Promise<string> => {
    const events = await getEvents();
    return JSON.stringify(events.slice(-n));
  };
};
