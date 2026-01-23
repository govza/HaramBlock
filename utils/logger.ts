import { createConsola, type ConsolaReporter, type LogObject } from 'consola/basic';

// Set log level based on environment
// 5 = verbose (dev mode), 0 = silent (production mode)
const logLevel = import.meta.env.DEV ? 5 : 0;

// Style colors per log type (matching consola browser defaults)
const typeColors: Record<string, string> = {
  info: '#3498db',
  warn: '#f39c12',
  debug: '#9b59b6',
  log: '#2ecc71',
  success: '#2ecc71',
};

// Beautify URLs in strings by extracting digit identifiers (dev mode only)
const beautifyUrls = (value: unknown): unknown => {
  if (!import.meta.env.DEV) return value;

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

// Custom reporter: plain errors, styled everything else
const customReporter: ConsolaReporter = {
  log(logObj: LogObject) {
    const { tag, type, args } = logObj;
    const beautifiedArgs = args.map(beautifyUrls);

    if (type === 'error') {
      const prefix = tag ? `[${tag}] [error]` : '[error]';

      console.error(prefix, ...beautifiedArgs);
    } else {
      const color = typeColors[type] ?? '#2ecc71';
      const label = tag ? `${tag}:${type}` : type;
      const style = `background: ${color}; border-radius: 0.5em; color: white; font-weight: bold; padding: 2px 0.5em;`;
      // eslint-disable-next-line no-console
      console.log(`%c${label}`, style, ...beautifiedArgs);
    }
  },
};

// Create logger with proper level configuration
export const logger = createConsola({
  level: logLevel,
  reporters: [customReporter],
  defaults: {
    tag: 'HaramBlock',
  },
});
