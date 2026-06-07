import { logger } from '@/utils/logger';

export type ModelPreference = 'auto' | (string & {});

export interface ModelSettings {
  preference: ModelPreference;
}

const STORAGE_KEY = 'modelSettings';
const DEFAULT_SETTINGS: ModelSettings = { preference: 'auto' };

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export const getModelSettings = async (): Promise<ModelSettings> => {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as ModelSettings) ?? DEFAULT_SETTINGS;
};

export const setModelSettings = async (settings: Partial<ModelSettings>): Promise<void> => {
  const current = await getModelSettings();
  const newSettings = { ...current, ...settings };

  if (settings.preference && settings.preference !== current.preference) {
    logger.withTag('modelSettings').info(`Model preference changed: ${current.preference} → ${settings.preference}`);
  }

  await browser.storage.local.set({
    [STORAGE_KEY]: newSettings,
  });
};

export const onModelSettingsChange = (callback: (settings: ModelSettings) => void): (() => void) => {
  const listener = (changes: Record<string, StorageChange>) => {
    const change = changes[STORAGE_KEY];
    if (change?.newValue) {
      callback(change.newValue as ModelSettings);
    }
  };
  browser.storage.local.onChanged.addListener(listener);
  return () => browser.storage.local.onChanged.removeListener(listener);
};
