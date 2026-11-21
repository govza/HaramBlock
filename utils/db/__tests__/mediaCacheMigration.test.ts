import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { MediaCacheDatabase } from '@/utils/db/db';

import type { Provenance } from '@/utils/types';

const SRC = 'https://cdn.example.com/a.jpg';
const VIDEO_KEY = 'url:https://example.com/video.mp4';
const PENDING = ['pending', Dexie.minKey];
const PENDING_END = ['pending', Dexie.maxKey];

async function seedSchemaV4(): Promise<void> {
  const legacy = new Dexie('MediaCacheDatabase');
  legacy.version(4).stores({
    imagePredictions: '&src, hostname, timestamp, [hostname+timestamp]',
    videos: '&identityKey, hostname, timestamp, [hostname+timestamp]',
    videoSampleBuckets: '[identityKey+modelId+latticeVersion+bucketStartUs], identityKey, hostname',
  });
  await legacy.table('imagePredictions').put({ src: SRC, hostname: 'example.com', timestamp: 1, predictions: [] });
  await legacy.table('videos').put({
    identityKey: VIDEO_KEY,
    hostname: 'example.com',
    timestamp: 1,
    forcedVisibility: 'blocked',
    sampleCounts: { 'sem-i320@20260607': 3 },
    modelCompatibility: { 'sem-i320@20260607': 'semantic:aurat_female,aurat_male' },
  });
  await legacy.table('videoSampleBuckets').put({
    identityKey: VIDEO_KEY,
    modelId: 'sem-i320@20260607',
    latticeVersion: 1,
    bucketStartUs: 0,
    hostname: 'example.com',
    samples: [],
  });
  legacy.close();
}

const bucket = (provenance: Provenance) => ({
  identityKey: VIDEO_KEY,
  modelId: 'sem-i320@20260607',
  latticeVersion: 1,
  formatVersion: 1,
  bucketStartUs: 0,
  hostname: 'example.com',
  samples: [],
  provenance,
});

describe('MediaCacheDatabase schema v5', () => {
  afterEach(() => Dexie.delete('MediaCacheDatabase'));

  it('keeps v4 image rows as own predictions without a Report Status', async () => {
    await seedSchemaV4();
    const db = new MediaCacheDatabase();
    const row = await db.imagePredictions.get(SRC);
    expect(row).toMatchObject({ src: SRC, hostname: 'example.com', provenance: 'own' });
    expect(row).not.toHaveProperty('reportStatus');
    expect(row).not.toHaveProperty('reportChangedAt');
    db.close();
  });

  it('drops v4 video sample buckets and the counts that pointed at them, keeping Forced Visibility', async () => {
    await seedSchemaV4();
    const db = new MediaCacheDatabase();
    expect(await db.videoSampleBuckets.count()).toBe(0);
    expect(await db.videos.get(VIDEO_KEY)).toMatchObject({
      forcedVisibility: 'blocked',
      sampleCounts: {},
      modelCompatibility: {},
    });
    db.close();
  });

  it('holds an own and a served bucket for the same video, model, lattice and bucket start', async () => {
    const db = new MediaCacheDatabase();
    await db.videoSampleBuckets.bulkPut([bucket('own'), bucket('served')]);
    expect(await db.videoSampleBuckets.count()).toBe(2);
    db.close();
  });

  it('finds pending rows of both tables by Report Status, oldest change first', async () => {
    const db = new MediaCacheDatabase();
    await db.videoSampleBuckets.bulkPut([
      { ...bucket('own'), reportStatus: 'pending', reportChangedAt: 7 },
      { ...bucket('served') },
    ]);
    await db.imagePredictions.bulkPut([
      { src: 'b', reportStatus: 'pending', reportChangedAt: 9 },
      { src: 'a', reportStatus: 'pending', reportChangedAt: 3 },
      { src: 'c', reportStatus: 'reported', reportChangedAt: 1 },
      { src: 'd' },
    ] as never);
    const byStatus = '[reportStatus+reportChangedAt]';
    expect(await db.imagePredictions.where(byStatus).between(PENDING, PENDING_END).primaryKeys()).toEqual(['a', 'b']);
    expect(await db.videoSampleBuckets.where(byStatus).between(PENDING, PENDING_END).count()).toBe(1);
    db.close();
  });
});
