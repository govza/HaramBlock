import { createConsola } from 'consola/basic';

// Set log level based on environment
// 5 = verbose (dev mode), 0 = silent (production mode)
const logLevel = import.meta.env.DEV ? 5 : 0;

// Create logger with proper level configuration
export const logger = createConsola({
  level: logLevel,
  defaults: {
    tag: "HaramBlock",
  },
});
