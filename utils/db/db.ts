import Dexie, { type Table } from 'dexie';

import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';

import type {
  IHostSettings,
  IStoredImagePrediction,
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

/**
 * Dexie cannot change a primary key in place, so the version before schema v5 drops the video sample
 * buckets and v5 recreates them under the key that carries provenance.
 */
const DROP_REKEYED_VIDEO_BUCKETS_VERSION = 4.5;

export class MediaCacheDatabase extends Dexie {
  imagePredictions!: Table<IStoredImagePrediction, string>;
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
    this.version(DROP_REKEYED_VIDEO_BUCKETS_VERSION).stores({ videoSampleBuckets: null });
    this.version(5)
      .stores({
        imagePredictions: '&src, hostname, timestamp, [hostname+timestamp], [reportStatus+reportChangedAt]',
        videoSampleBuckets:
          '[identityKey+modelId+latticeVersion+provenance+bucketStartUs], identityKey, hostname, [reportStatus+reportChangedAt]',
      })
      .upgrade(async tx => {
        await tx.table<IStoredImagePrediction>('imagePredictions').toCollection().modify({ provenance: 'own' });
        await tx
          .table<IVideoPredictionRecord>('videos')
          .toCollection()
          .modify({ sampleCounts: {}, modelCompatibility: {} });
      });
  }
}

export const mediaCacheDb = new MediaCacheDatabase();

const LEGACY_CACHE_DATABASE_NAMES = ['ImageDatabase', 'VideoDatabase'];

export const deleteLegacyCacheDatabases = () =>
  Promise.all(LEGACY_CACHE_DATABASE_NAMES.map(name => Dexie.delete(name)));

/** Whether running in incognito context */
export const isIncognito = browser.extension.inIncognitoContext;
