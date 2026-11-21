import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mediaCacheDb } from '@/utils/db/db';
import {
  bucketStartOf,
  groupByBucket,
  isVideoCacheFresh,
  mergeVideoSamples,
  VIDEO_SAMPLE_BUCKET_US,
  VideoPredictionRepository,
} from '@/utils/db/videoPredictionRepository';

import type { IPersistentVideoIdentity, IStoredVideoSample } from '@/utils/types';

function sample(pointUs: number, topUnsafeScore = 0.1): IStoredVideoSample {
  return {
    pointUs,
    scores: { kind: 'detections', detections: [] },
    input: { width: 640, height: 360, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
    topUnsafeScore,
  };
}

const IDENTITY_TRANSFORM = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };

function analysedFrom(source: { width: number; height: number } | null, topUnsafeScore: number): IStoredVideoSample {
  const scale = source ? Math.min(1, 320 / Math.max(source.width, source.height)) : 1;
  const input = source
    ? { width: Math.round(source.width * scale), height: Math.round(source.height * scale) }
    : { width: 320, height: 180 };
  return {
    pointUs: 1_000_000,
    scores: { kind: 'detections', detections: [] },
    input: { ...input, maskTransform: IDENTITY_TRANSFORM },
    topUnsafeScore,
    ...(source ? { source } : {}),
  };
}

const P1080 = { width: 1920, height: 1080 };
const P360 = { width: 640, height: 360 };
const P144 = { width: 256, height: 144 };

const keptScore = (existing: IStoredVideoSample, incoming: IStoredVideoSample) =>
  mergeVideoSamples([existing], [incoming])[0]?.topUnsafeScore;

const MINUTE_US = 60_000_000;

describe('mergeVideoSamples', () => {
  it('keys samples by exact point, sorted', () => {
    const merged = mergeVideoSamples([sample(2_000_000), sample(1_000_000)], [sample(2_000_000, 0.8), sample(500_000)]);
    expect(merged.map(e => e.pointUs)).toEqual([500_000, 1_000_000, 2_000_000]);
  });

  it('never replaces a sample analysed from a higher resolution with a lower one', () => {
    expect(keptScore(analysedFrom(P1080, 0.1), analysedFrom(P144, 0.9))).toBe(0.1);
  });

  it('replaces a sample analysed from a lower resolution with a higher one', () => {
    expect(keptScore(analysedFrom(P144, 0.1), analysedFrom(P1080, 0.9))).toBe(0.9);
  });

  it('prefers more source pixels once both sources exceed the model input', () => {
    expect(keptScore(analysedFrom(P360, 0.1), analysedFrom(P1080, 0.9))).toBe(0.9);
    expect(keptScore(analysedFrom(P1080, 0.1), analysedFrom(P360, 0.9))).toBe(0.1);
  });

  it('keeps the stored sample on equal quality', () => {
    expect(keptScore(analysedFrom(P1080, 0.1), analysedFrom(P1080, 0.9))).toBe(0.1);
  });

  it('ranks a sample without a source size by its model input size', () => {
    expect(keptScore(analysedFrom(null, 0.1), analysedFrom(P144, 0.9))).toBe(0.1);
    expect(keptScore(analysedFrom(P144, 0.1), analysedFrom(null, 0.9))).toBe(0.9);
    expect(keptScore(analysedFrom(null, 0.1), analysedFrom(P1080, 0.9))).toBe(0.9);
  });

  it('keeps neighbouring points apart however close they are', () => {
    const merged = mergeVideoSamples([sample(1_000_000)], [sample(1_062_500)]);
    expect(merged.map(e => e.pointUs)).toEqual([1_000_000, 1_062_500]);
  });

  it('has no sample cap', () => {
    const existing = Array.from({ length: 5000 }, (_, i) => sample(i * 62_500));
    expect(mergeVideoSamples(existing, [sample(5000 * 62_500)])).toHaveLength(5001);
  });
});

describe('sample buckets', () => {
  it('span five minutes of media time', () => {
    expect(VIDEO_SAMPLE_BUCKET_US).toBe(5 * MINUTE_US);
    expect(bucketStartOf(0)).toBe(0);
    expect(bucketStartOf(5 * MINUTE_US - 1)).toBe(0);
    expect(bucketStartOf(5 * MINUTE_US)).toBe(5 * MINUTE_US);
    expect(bucketStartOf(61 * MINUTE_US)).toBe(60 * MINUTE_US);
  });

  it('group samples by the bucket their point falls in', () => {
    const grouped = groupByBucket([sample(6 * MINUTE_US), sample(1_000_000), sample(4 * MINUTE_US)]);
    expect([...grouped.entries()].map(([start, samples]) => [start, samples.map(s => s.pointUs)])).toEqual([
      [5 * MINUTE_US, [6 * MINUTE_US]],
      [0, [1_000_000, 4 * MINUTE_US]],
    ]);
  });
});

describe('VideoPredictionRepository Report Status', () => {
  const VIDEO: IPersistentVideoIdentity = {
    kind: 'stable',
    key: 'url:https://example.com/video.mp4',
    durationSec: 3600,
  };
  const MODEL = { modelId: 'sem-i320@20260607', compatibilityKey: 'semantic:aurat_female,aurat_male' };
  const NOW = 1_800_000_000_000;
  const ORIGIN = {
    sourceUrl: 'https://example.com/video.mp4',
    pageUrl: 'https://example.com/watch/42',
    hostname: 'example.com',
    cacheMetadata: { createdAt: NOW, accessedAt: NOW, maxAge: 2_592_000 },
  };
  const SECOND_BUCKET_US = 6 * MINUTE_US;
  const repository = new VideoPredictionRepository();

  const bucketsByStart = async () => {
    const buckets = await mediaCacheDb.videoSampleBuckets.toArray();
    return buckets.sort((a, b) => a.bucketStartUs - b.bucketStartUs);
  };

  const markAllReported = () =>
    mediaCacheDb.videoSampleBuckets.toCollection().modify({ reportStatus: 'reported', reportChangedAt: 1 });

  const storeOwn = (samples: IStoredVideoSample[], isReportable = true) =>
    repository.storeOwn(VIDEO, MODEL, ORIGIN, samples, isReportable);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await mediaCacheDb.videoSampleBuckets.clear();
    await mediaCacheDb.videos.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores reportable own samples in a pending own bucket', async () => {
    await expect(storeOwn([sample(1_000_000)])).resolves.toBe(true);
    expect(await bucketsByStart()).toMatchObject([
      { bucketStartUs: 0, provenance: 'own', reportStatus: 'pending', reportChangedAt: NOW },
    ]);
  });

  it('gives samples the eligibility filter rejected no Report Status', async () => {
    await expect(storeOwn([sample(1_000_000)], false)).resolves.toBe(false);
    const [bucket] = await bucketsByStart();
    expect(bucket).toMatchObject({ provenance: 'own' });
    expect(bucket).not.toHaveProperty('reportStatus');
    expect(bucket).not.toHaveProperty('reportChangedAt');
  });

  it('keeps a reported bucket reported when a write adds nothing to it', async () => {
    await storeOwn([sample(1_000_000)]);
    await markAllReported();
    await expect(storeOwn([sample(1_000_000)])).resolves.toBe(false);
    expect(await bucketsByStart()).toMatchObject([{ reportStatus: 'reported', reportChangedAt: 1 }]);
  });

  it('keeps the hostname a pending bucket is reported under when the video replays on another host', async () => {
    await storeOwn([sample(1_000_000)]);
    const replayOrigin = { ...ORIGIN, hostname: 'wiki.corp.internal' };
    await repository.storeOwn(VIDEO, MODEL, replayOrigin, [sample(1_000_000)], false);
    await repository.setForcedVisibility(VIDEO, replayOrigin, 'blocked');
    expect(await bucketsByStart()).toMatchObject([
      { hostname: 'wiki.corp.internal', reportHostname: 'example.com', reportStatus: 'pending' },
    ]);
  });

  it('marks only the bucket that gained samples pending again', async () => {
    await storeOwn([sample(1_000_000), sample(SECOND_BUCKET_US)]);
    await markAllReported();
    await expect(storeOwn([sample(SECOND_BUCKET_US + 1_000_000)])).resolves.toBe(true);
    expect(await bucketsByStart()).toMatchObject([
      { bucketStartUs: 0, reportStatus: 'reported' },
      { bucketStartUs: 5 * MINUTE_US, reportStatus: 'pending', reportChangedAt: NOW },
    ]);
  });

  it("marks only the video's earliest bucket pending when its Forced Visibility flips", async () => {
    await storeOwn([sample(1_000_000), sample(SECOND_BUCKET_US)]);
    await markAllReported();
    await expect(repository.setForcedVisibility(VIDEO, ORIGIN, 'blocked')).resolves.toBe(true);
    expect(await bucketsByStart()).toMatchObject([
      { bucketStartUs: 0, reportStatus: 'pending', reportChangedAt: NOW },
      { bucketStartUs: 5 * MINUTE_US, reportStatus: 'reported' },
    ]);
  });

  it('skips buckets without a Report Status when a Forced Visibility flip picks the earliest', async () => {
    await storeOwn([sample(1_000_000)], false);
    await storeOwn([sample(SECOND_BUCKET_US)]);
    vi.setSystemTime(NOW + 1000);
    await repository.setForcedVisibility(VIDEO, ORIGIN, 'blocked');
    const [earliest, later] = await bucketsByStart();
    expect(earliest).not.toHaveProperty('reportStatus');
    expect(later).toMatchObject({ reportStatus: 'pending', reportChangedAt: NOW + 1000 });
  });

  it('marks nothing when a video with no bucket gets a Forced Visibility', async () => {
    await expect(repository.setForcedVisibility(VIDEO, ORIGIN, 'blocked')).resolves.toBe(false);
    expect(await mediaCacheDb.videoSampleBuckets.count()).toBe(0);
    expect((await mediaCacheDb.videos.get(VIDEO.key))?.forcedVisibility).toBe('blocked');
  });

  it('does not re-report a toggle that changes nothing, or an access-time touch', async () => {
    await storeOwn([sample(1_000_000)]);
    await markAllReported();
    await expect(repository.setForcedVisibility(VIDEO, ORIGIN, 'auto')).resolves.toBe(false);
    await repository.touch(VIDEO.key);
    expect(await bucketsByStart()).toMatchObject([{ reportStatus: 'reported', reportChangedAt: 1 }]);
  });

  it('counts and reads own samples only', async () => {
    await mediaCacheDb.videoSampleBuckets.put({
      identityKey: VIDEO.key,
      modelId: MODEL.modelId,
      bucketStartUs: 0,
      latticeVersion: 1,
      formatVersion: 1,
      hostname: 'example.com',
      samples: [sample(2_000_000), sample(3_000_000), sample(4_000_000)],
      provenance: 'served',
      servedAt: NOW,
    });
    await storeOwn([sample(1_000_000), sample(1_500_000)]);
    expect((await mediaCacheDb.videos.get(VIDEO.key))?.sampleCounts).toEqual({ [MODEL.modelId]: 2 });
    const read = await repository.readSamples(VIDEO.key, MODEL.modelId);
    expect(read.map(stored => stored.pointUs)).toEqual([1_000_000, 1_500_000]);
  });
});

describe('isVideoCacheFresh', () => {
  const DAY_MS = 86_400_000;
  const record = (createdAt: number, accessedAt: number) => ({
    cacheMetadata: { createdAt, accessedAt, maxAge: DAY_MS / 1000 },
  });

  it('expires a video by its last access, not its creation', () => {
    const now = 10 * DAY_MS;
    expect(isVideoCacheFresh(record(0, now - DAY_MS / 2), now)).toBe(true);
    expect(isVideoCacheFresh(record(0, now - 2 * DAY_MS), now)).toBe(false);
  });
});
