import { liveQuery, type Subscription } from 'dexie';

import { hostSettingsDb } from '@/utils/db/db';
import { logger } from '@/utils/logger';

import type { IHostSettings } from '@/utils/types';

type SettingsChangedCallback = (hostname: string) => void;

const areSettingsEqual = (a: IHostSettings, b: IHostSettings): boolean => {
  return (
    a.hostname === b.hostname &&
    a.isGlobal === b.isGlobal &&
    a.policy === b.policy &&
    a.outline === b.outline &&
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
 * Observes hostSettings table changes using Dexie's liveQuery.
 * Triggers callback when any settings are modified.
 */
export class HostSettingsObserver {
  private previousSettings = new Map<string, IHostSettings>();
  private subscription: Subscription | null = null;

  initialize(onSettingsChanged: SettingsChangedCallback): void {
    const observable = liveQuery(() => hostSettingsDb.hostSettings.toArray());

    this.subscription = observable.subscribe({
      next: settings => {
        this.detectChanges(settings, onSettingsChanged);
      },
      error: error => {
        logger.withTag('hostSettingsObserver').error('liveQuery error:', error);
      },
    });

    logger.withTag('hostSettingsObserver').log('Initialized liveQuery observer for hostSettings');
  }

  dispose(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    this.previousSettings.clear();
  }

  private detectChanges(currentSettings: IHostSettings[], onSettingsChanged: SettingsChangedCallback): void {
    const currentMap = new Map(currentSettings.map(s => [s.hostname, s]));

    // Detect updated or new settings
    for (const [hostname, settings] of currentMap) {
      const previous = this.previousSettings.get(hostname);
      if (!previous || !areSettingsEqual(previous, settings)) {
        logger.withTag('hostSettingsObserver').debug('Settings changed for:', hostname);
        onSettingsChanged(hostname);
      }
    }

    // Detect deleted settings
    for (const hostname of this.previousSettings.keys()) {
      if (!currentMap.has(hostname)) {
        logger.withTag('hostSettingsObserver').debug('Settings deleted for:', hostname);
        onSettingsChanged(hostname);
      }
    }

    this.previousSettings = currentMap;
  }
}
