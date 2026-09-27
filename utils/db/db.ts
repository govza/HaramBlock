import Dexie, { type Table } from 'dexie';

import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';

import type { IHostSettings, IImagePrediction, IVideoPredictionRecord } from '@/utils/types';

/**
 * HostSettingsDatabase - Dexie database for host settings
 * Stores settings for each hostname, including global settings
 */
export class HostSettingsDatabase extends Dexie {
  hostSettings!: Table<IHostSettings, string>;

  constructor() {
    super('HostSettingsDatabase');
    this.version(1).stores({
      hostSettings: '&hostname', // Primary unique key
    });
  }
}

export const hostSettingsDb = new HostSettingsDatabase();

hostSettingsDb.on('populate', () => {
  // Initialize with default global settings
  void hostSettingsDb.hostSettings.add(DEFAULT_HOST_SETTINGS);
});

export class MediaCacheDatabase extends Dexie {
  imagePredictions!: Table<IImagePrediction, string>;
  videoPredictions!: Table<IVideoPredictionRecord, string>;

  constructor() {
    super('MediaCacheDatabase');
    this.version(1).stores({
      imagePredictions: '&src, hostname, timestamp, [hostname+timestamp]',
      videoPredictions: '&videoUrl, hostname, timestamp, [hostname+timestamp]',
    });
  }
}

export const mediaCacheDb = new MediaCacheDatabase();

const LEGACY_CACHE_DATABASE_NAMES = ['ImageDatabase', 'VideoDatabase'];

export const deleteLegacyCacheDatabases = () =>
  Promise.all(LEGACY_CACHE_DATABASE_NAMES.map(name => Dexie.delete(name)));

/** Whether running in incognito/private browsing mode */
export const isIncognito = browser.extension.inIncognitoContext;
