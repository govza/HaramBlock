import { liveQuery } from 'dexie';

import { hostSettingsDb } from '@/utils/db/db';
import { logger } from '@/utils/logger';

import type { IHostSettings } from '@/utils/types';

type SettingsChangedCallback = (hostname: string) => void;
const SESSION_STORAGE_PREFIX = 'hostSettings:';

const areSettingsEqual = (a: IHostSettings, b: IHostSettings): boolean => {
  return (
    a.hostname === b.hostname &&
    a.isGlobal === b.isGlobal &&
    a.policy.behavior === b.policy.behavior &&
    a.strictness === b.strictness &&
    a.minSize.width === b.minSize.width &&
    a.minSize.height === b.minSize.height &&
    a.masking.grayscale === b.masking.grayscale &&
    a.masking.dark === b.masking.dark &&
    a.masking.blurIntensity === b.masking.blurIntensity &&
    a.masking.pixelationScale === b.masking.pixelationScale &&
    a.quickToggle.unsafeEnabled === b.quickToggle.unsafeEnabled &&
    a.quickToggle.safeEnabled === b.quickToggle.safeEnabled
  );
};

/**
 * Initializes a hostSettings table observer using Dexie's liveQuery.
 * Triggers callback when any settings are modified.
 */
export function initHostSettingsObserver(onSettingsChanged: SettingsChangedCallback): void {
  let previousSettings = new Map<string, IHostSettings>();

  const detectChanges = (currentSettings: IHostSettings[]): void => {
    const currentMap = new Map(currentSettings.map(s => [s.hostname, s]));

    // Detect updated or new settings
    for (const [hostname, settings] of currentMap) {
      const previous = previousSettings.get(hostname);
      if (!previous || !areSettingsEqual(previous, settings)) {
        onSettingsChanged(hostname);
      }
    }

    // Detect deleted settings
    for (const hostname of previousSettings.keys()) {
      if (!currentMap.has(hostname)) {
        onSettingsChanged(hostname);
      }
    }

    previousSettings = currentMap;
  };

  const observable = liveQuery(() => hostSettingsDb.hostSettings.toArray());

  observable.subscribe({
    next: detectChanges,
    error: error => {
      logger.withTag('hostSettingsObserver').error('liveQuery error:', error);
    },
  });

  // Private/incognito host settings are stored in browser.storage.session.
  // Listen for those writes/deletes so the same callback path is triggered.
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session') {
      return;
    }

    const changedHostnames = new Set<string>();
    for (const key of Object.keys(changes)) {
      if (!key.startsWith(SESSION_STORAGE_PREFIX)) {
        continue;
      }
      const hostname = key.slice(SESSION_STORAGE_PREFIX.length);
      if (hostname) {
        changedHostnames.add(hostname);
      }
    }

    changedHostnames.forEach(hostname => onSettingsChanged(hostname));
  });

  logger.withTag('hostSettingsObserver').info('Initialized hostSettings observers (Dexie + session storage)');
}
