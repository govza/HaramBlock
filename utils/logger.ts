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

// Custom reporter: plain errors, styled everything else
const customReporter: ConsolaReporter = {
  log(logObj: LogObject) {
    const { tag, type, args } = logObj;

    if (type === 'error') {
      const prefix = tag ? `[${tag}] [error]` : '[error]';

      console.error(prefix, ...(args as unknown[]));
    } else {
      const color = typeColors[type] ?? '#2ecc71';
      const label = tag ? `${tag}:${type}` : type;
      const style = `background: ${color}; border-radius: 0.5em; color: white; font-weight: bold; padding: 2px 0.5em;`;
      // eslint-disable-next-line no-console
      console.log(`%c${label}`, style, ...(args as unknown[]));
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

// Utility function to extract digit group from image URLs or return full URL
export const extractUrlId = (imgUrl: string): string => {
  if (import.meta.env.DEV) {
    const match = imgUrl.match(/(\d+)/);
    if (match) return match[1] ?? imgUrl;
  }
  return imgUrl;
};
