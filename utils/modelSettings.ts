import { getLogger } from '@/utils/telemetry';

const log = getLogger('modelSettings');

export type ModelPreference = 'auto' | (string & {});

/**
 * Persisted state of the automatic model switcher. Everything the switcher needs to be stable
 * across service-worker restarts lives here - the old auto switcher kept its cooldowns in memory,
 * so every SW restart re-armed it and it could ratchet models down repeatedly.
 */
export interface AutoModelState {
  selectedModelId?: string; // What auto chose (applied on startup)
  backend?: string; // Backend the state was built on; a mismatch invalidates the whole state
  settledAt?: number; // Set once auto has converged; cleared when re-evaluation is needed
  lastSwitchAt?: number; // Cooldown anchor for auto switches
  measured?: Record<string, { p75Ms: number; at: number }>; // Per-model measured latency on `backend`
}

export interface ModelSettings {
  preference?: ModelPreference; // undefined is treated as 'auto'
  auto?: AutoModelState;
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
    log.info('settings.model_preference.changed', {
      fromPreference: current.preference,
      toPreference: settings.preference,
    });
  }

  await browser.storage.local.set({
    [STORAGE_KEY]: newSettings,
  });
};

/** Merge a partial update into the persisted auto switcher state. */
export const updateAutoModelState = async (patch: Partial<AutoModelState>): Promise<void> => {
  const current = await getModelSettings();
  await setModelSettings({ auto: { ...current.auto, ...patch } });
};

export const onModelSettingsChange = (callback: (settings: ModelSettings) => void): (() => void) => {
  const listener = (changes: Record<string, StorageChange>) => {
    const change = changes[STORAGE_KEY];
    if (change?.newValue) {
      callback(change.newValue);
    }
  };
  browser.storage.local.onChanged.addListener(listener);
  return () => browser.storage.local.onChanged.removeListener(listener);
};
