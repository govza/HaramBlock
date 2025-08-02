import Dexie, { type Table } from 'dexie';

import { defaultHostSettings } from '@/utils/db/constants';
import { type IHostSettings, type IImagePrediction } from '@/utils/types';

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
  void hostSettingsDb.hostSettings.add(defaultHostSettings);
});

/**
 * PredictionsDatabase - Dexie database for prediction records
 * Stores predictions with metadata like hostname, timestamp, and image dimensions
 */
export class PredictionsDatabase extends Dexie {
  predictions!: Table<IImagePrediction, string>;

  constructor() {
    super('PredictionDatabase');
    this.version(1).stores({
      predictions: '&src, hostname, timestamp', // Primary key is src, with hostname and timestamp as secondary keys
    });
  }
}

export const predictionsDb = new PredictionsDatabase();
