import Dexie, { type Table } from 'dexie';

import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';

import type { IHostSettings, IImagePrediction } from '@/utils/types';

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

/**
 * ImageDatabase - Dexie database for image prediction records
 * Stores image predictions with metadata like hostname, timestamp, and dimensions
 */
export class ImageDatabase extends Dexie {
  predictions!: Table<IImagePrediction, string>;

  constructor() {
    super('ImageDatabase');
    this.version(1).stores({
      predictions: '&src, hostname, timestamp', // Primary key is src, with hostname and timestamp as secondary keys
    });
  }
}

export const imageDb = new ImageDatabase();
