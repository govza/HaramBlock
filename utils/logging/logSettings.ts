import type { LogSettings } from '@/utils/logging/types';

const STORAGE_KEY = 'logSettings';
const DEFAULT_SETTINGS: LogSettings = {
  consoleEnabled: false,
  otlpEnabled: false,
  otlpEndpoint: 'http://localhost:4318',
};

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export const getLogSettings = async (): Promise<LogSettings> => {
  const result = await browser.storage.local.get(STORAGE_KEY);
  // Spread over defaults so installs that stored only older fields keep working
  return { ...DEFAULT_SETTINGS, ...((result[STORAGE_KEY] as Partial<LogSettings>) ?? {}) };
};

export const setLogSettings = async (settings: Partial<LogSettings>): Promise<void> => {
  const current = await getLogSettings();
  await browser.storage.local.set({
    [STORAGE_KEY]: { ...current, ...settings },
  });
};

export const onLogSettingsChange = (callback: (settings: LogSettings) => void): (() => void) => {
  const listener = (changes: Record<string, StorageChange>) => {
    const change = changes[STORAGE_KEY];
    if (change?.newValue) {
      callback({ ...DEFAULT_SETTINGS, ...(change.newValue as Partial<LogSettings>) });
    }
  };
  browser.storage.local.onChanged.addListener(listener);
  return () => browser.storage.local.onChanged.removeListener(listener);
};
