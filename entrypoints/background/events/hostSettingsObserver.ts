import { liveQuery } from 'dexie';

import { hostSettingsDb } from '@/utils/db/db';
import { logger } from '@/utils/logger';

import type { IHostSettings } from '@/utils/types';

type SettingsChangedCallback = (hostname: string) => void;

/**
 * Observes hostSettings table changes using Dexie's liveQuery.
 * Triggers callback when any settings are modified.
 */
export class HostSettingsObserver {
  private previousSettings = new Map<string, IHostSettings>();

  initialize(onSettingsChanged: SettingsChangedCallback): void {
    const observable = liveQuery(() => hostSettingsDb.hostSettings.toArray());

    observable.subscribe({
      next: settings => {
        this.detectChanges(settings, onSettingsChanged);
      },
      error: error => {
        logger.withTag('hostSettingsObserver').error('liveQuery error:', error);
      },
    });

    logger.withTag('hostSettingsObserver').log('Initialized liveQuery observer for hostSettings');
  }

  private detectChanges(currentSettings: IHostSettings[], onSettingsChanged: SettingsChangedCallback): void {
    const currentMap = new Map(currentSettings.map(s => [s.hostname, s]));

    // Detect updated or new settings
    for (const [hostname, settings] of currentMap) {
      const previous = this.previousSettings.get(hostname);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(settings)) {
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
