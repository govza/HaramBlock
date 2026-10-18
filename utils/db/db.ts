import Dexie, { type Table } from 'dexie';

import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';

import type {
  IHostSettings,
  IImagePrediction,
  IVideoPredictionRecord,
  IVideoSampleBucket,
  SampleBucketKey,
} from '@/utils/types';

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
  videos!: Table<IVideoPredictionRecord, string>;
  videoSampleBuckets!: Table<IVideoSampleBucket, SampleBucketKey>;

  constructor() {
    super('MediaCacheDatabase');
    this.version(1).stores({
      imagePredictions: '&src, hostname, timestamp, [hostname+timestamp]',
      videoPredictions: '&videoUrl, hostname, timestamp, [hostname+timestamp]',
    });
    this.version(2)
      .stores({
        imagePredictions: '&src, hostname, timestamp, [hostname+timestamp]',
        videoPredictions: '&videoUrl, hostname, timestamp, [hostname+timestamp]',
      })
      .upgrade(tx => tx.table('videoPredictions').clear());
    this.version(3)
      .stores({
        imagePredictions: '&src, hostname, timestamp, [hostname+timestamp]',
        videoPredictions: '&videoUrl, hostname, timestamp, [hostname+timestamp]',
        videoSamples: '[videoUrl+modelId+bucketStartUs], videoUrl, hostname',
      })
      .upgrade(tx => tx.table('videoPredictions').clear());
    this.version(4).stores({
      imagePredictions: '&src, hostname, timestamp, [hostname+timestamp]',
      videoPredictions: null,
      videoSamples: null,
      videos: '&identityKey, hostname, timestamp, [hostname+timestamp]',
      videoSampleBuckets: '[identityKey+modelId+latticeVersion+bucketStartUs], identityKey, hostname',
    });
  }
}

export const mediaCacheDb = new MediaCacheDatabase();

const LEGACY_CACHE_DATABASE_NAMES = ['ImageDatabase', 'VideoDatabase'];

export const deleteLegacyCacheDatabases = () =>
  Promise.all(LEGACY_CACHE_DATABASE_NAMES.map(name => Dexie.delete(name)));

/** Whether running in incognito/private browsing mode */
export const isIncognito = browser.extension.inIncognitoContext;
