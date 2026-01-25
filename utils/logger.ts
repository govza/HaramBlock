import { createConsola, type ConsolaReporter, type LogObject } from 'consola/basic';

import { getLogSettings, onLogSettingsChange } from '@/utils/logging/logSettings';

// Cache settings to avoid async lookup on every log
let cachedConsoleEnabled = false;

// Initialize and listen for changes
const initLoggerSettings = async () => {
  try {
    const settings = await getLogSettings();
    cachedConsoleEnabled = settings.consoleEnabled;

    onLogSettingsChange(settings => {
      cachedConsoleEnabled = settings.consoleEnabled;
    });
  } catch {
    // Silent fail - browser.storage may not be available during initial load
  }
};

// Initialize on module load (fire and forget)
void initLoggerSettings();

// Dynamic check: dev mode always logs, production checks setting
const shouldLog = (): boolean => {
  return import.meta.env.DEV || cachedConsoleEnabled;
};

// Style colors per log type (matching consola browser defaults)
const typeColors: Record<string, string> = {
  info: '#3498db',
  warn: '#f39c12',
  debug: '#9b59b6',
  log: '#2ecc71',
  success: '#2ecc71',
};

// Shorten URLs in strings by extracting digit identifiers
const beautifyUrls = (value: unknown): unknown => {
  if (typeof value === 'string') {
    // Match URLs (http/https/data or paths with image extensions)
    return value.replace(
      /(https?:\/\/[^\s]+|data:[^\s]+|\/[^\s]*\.(?:jpg|jpeg|png|gif|webp|svg|avif)[^\s]*)/gi,
      url => {
        const match = url.match(/(\d+)/);
        return match?.[1] ?? url;
      },
    );
  }

  if (Array.isArray(value)) {
    return value.map(beautifyUrls);
  }

  if (value && typeof value === 'object') {
    // Preserve Error instances and other built-in types
    if (
      value instanceof Error ||
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Map ||
      value instanceof Set
    ) {
      return value;
    }

    // Only transform plain objects
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      return value;
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = beautifyUrls(v);
    }
    return result;
  }

  return value;
};

// Custom reporter: respects shouldLog(), styled output
const customReporter: ConsolaReporter = {
  log(logObj: LogObject) {
    if (!shouldLog()) return;

    const { tag, type, args } = logObj;
    const beautifiedArgs = args.map(beautifyUrls);

    const color = typeColors[type] ?? '#2ecc71';
    const label = tag ? `${tag}:${type}` : type;
    const style = `background: ${color}; border-radius: 0.5em; color: white; font-weight: bold; padding: 2px 0.5em;`;

    if (type === 'error') {
      console.error(`%c${label}`, style, ...beautifiedArgs);
    } else if (type === 'debug') {
      // eslint-disable-next-line no-console
      console.debug(`%c${label}`, style, ...beautifiedArgs);
    } else if (type === 'warn') {
      console.warn(`%c${label}`, style, ...beautifiedArgs);
    } else {
      // eslint-disable-next-line no-console
      console.log(`%c${label}`, style, ...beautifiedArgs);
    }
  },
};

// Create logger - always level 5 internally, reporter controls output
export const logger = createConsola({
  level: 5,
  reporters: [customReporter],
  defaults: {
    tag: 'HaramBlock',
  },
});
