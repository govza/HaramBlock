import type { WideEvent } from '@/utils/logging/types';

/** One-line human-readable summary: `[reqId] status hostname +Nms (suffix) reason — error`. */
export const formatEventSummary = (event: WideEvent, suffix = ''): string => {
  const parts = [`[${event.reqId}]`, event.status, event.hostname, `+${event.totalMs}ms`];
  if (suffix) parts.push(`(${suffix})`);
  if (event.stage) parts.push(`stage=${event.stage}`);
  if (event.reason) parts.push(`reason=${event.reason}`);
  if (event.error?.message) parts.push(`— ${event.error.message}`);
  return parts.join(' ');
};

/**
 * Logs a wide event as ONE single-line string with the full payload as JSON.
 * Console captures that flatten objects (Playwright MCP's browser_console_messages
 * renders any logged object as the literal string "Object") can still read every field.
 */
export const logEventLine = (event: WideEvent, suffix = ''): void => {
  // eslint-disable-next-line no-console
  console.log(`${formatEventSummary(event, suffix)} ${JSON.stringify(event)}`);
};
