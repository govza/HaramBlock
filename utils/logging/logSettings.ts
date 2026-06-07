import type { LogSettings } from '@/utils/logging/types';

const STORAGE_KEY = 'logSettings';
const DEFAULT_SETTINGS: LogSettings = { consoleEnabled: false };

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export const getLogSettings = async (): Promise<LogSettings> => {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as LogSettings) ?? DEFAULT_SETTINGS;
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
      callback(change.newValue as LogSettings);
    }
  };
  browser.storage.local.onChanged.addListener(listener);
  return () => browser.storage.local.onChanged.removeListener(listener);
};
