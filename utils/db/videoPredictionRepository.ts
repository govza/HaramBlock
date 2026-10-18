import Dexie from 'dexie';

import { isCacheDisabled } from '@/utils/db/cacheAvailability';
import { mediaCacheDb } from '@/utils/db/db';
import { HostScopedCacheRepository } from '@/utils/db/hostScopedCacheRepository';
import { isValidPrediction } from '@/utils/db/predictionValidity';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { isDurationMismatch, type PersistentVideoIdentity } from '@/utils/videoIdentity';

import type { ForcedVisibility, ICacheMetadata, IStoredVideoSample, IVideoPredictionRecord } from '@/utils/types';

export const VIDEO_SAMPLE_BUCKET_US = 5 * 60 * 1_000_000;

export const bucketStartOf = (pointUs: number): number =>
  Math.floor(pointUs / VIDEO_SAMPLE_BUCKET_US) * VIDEO_SAMPLE_BUCKET_US;

export function groupByBucket(samples: readonly IStoredVideoSample[]): Map<number, IStoredVideoSample[]> {
  const buckets = new Map<number, IStoredVideoSample[]>();
  for (const sample of samples) {
    const bucketStartUs = bucketStartOf(sample.pointUs);
    const bucket = buckets.get(bucketStartUs) ?? [];
    bucket.push(sample);
    buckets.set(bucketStartUs, bucket);
  }
  return buckets;
}

export function mergeVideoSamples(
  existing: readonly IStoredVideoSample[],
  incoming: readonly IStoredVideoSample[],
): IStoredVideoSample[] {
  const byPoint = new Map<number, IStoredVideoSample>();
  for (const sample of existing) byPoint.set(sample.pointUs, sample);
  for (const sample of incoming) byPoint.set(sample.pointUs, sample);
  return [...byPoint.values()].sort((a, b) => a.pointUs - b.pointUs);
}

export const isVideoCacheFresh = (record: { cacheMetadata: ICacheMetadata }, now = Date.now()): boolean =>
  isValidPrediction({ cacheMetadata: { ...record.cacheMetadata, createdAt: record.cacheMetadata.accessedAt } }, now);

/**
 * Fields written to a video's meta row when samples or a forced visibility create it.
 */
export interface VideoPredictionOrigin {
  sourceUrl: string;
  hostname: string;
  cacheMetadata: ICacheMetadata;
}

const bucketKey = (identityKey: string, modelId: string, bucketStartUs: number): [string, string, number] => [
  identityKey,
  modelId,
  bucketStartUs,
];

const newRecord = (
  identity: PersistentVideoIdentity,
  origin: VideoPredictionOrigin,
  forcedVisibility: ForcedVisibility,
): IVideoPredictionRecord => ({
  identityKey: identity.key,
  identityKind: identity.kind,
  durationSec: identity.durationSec,
  sourceUrl: origin.sourceUrl,
  hostname: origin.hostname,
  forcedVisibility,
  timestamp: Date.now(),
  cacheMetadata: origin.cacheMetadata,
  sampleCounts: {},
});

export class VideoPredictionRepository extends HostScopedCacheRepository<IVideoPredictionRecord> {
  private readonly buckets = mediaCacheDb.videoSampleBuckets;

  constructor() {
    super(mediaCacheDb.videos);
  }

  async findValidByIdentityKey(identityKey: string): Promise<IVideoPredictionRecord | undefined> {
    if (isCacheDisabled) return undefined;
    const record = await this.table.get(identityKey);
    if (!record || !isVideoCacheFresh(record)) return undefined;
    return record;
  }

  async readSamples(identityKey: string, modelId: string): Promise<IStoredVideoSample[]> {
    if (isCacheDisabled) return [];
    const buckets = await this.buckets
      .where('[identityKey+modelId+bucketStartUs]')
      .between([identityKey, modelId, Dexie.minKey], [identityKey, modelId, Dexie.maxKey])
      .toArray();
    return buckets.flatMap(bucket => bucket.samples);
  }

  async mergeSamples(
    identity: PersistentVideoIdentity,
    modelId: string,
    origin: VideoPredictionOrigin,
    samples: readonly IStoredVideoSample[],
  ): Promise<void> {
    if (isCacheDisabled || samples.length === 0) return;
    await mediaCacheDb.transaction('rw', this.table, this.buckets, async () => {
      const stored = await this.table.get(identity.key);
      if (stored && !isVideoCacheFresh(stored)) {
        await this.buckets.where('identityKey').equals(identity.key).delete();
        await this.table.delete(identity.key);
      } else if (stored && isDurationMismatch(stored.durationSec, identity)) {
        await this.purgeSamplesWithin(identity);
      }
      let added = 0;
      for (const [bucketStartUs, incoming] of groupByBucket(samples)) {
        const existing = await this.buckets.get(bucketKey(identity.key, modelId, bucketStartUs));
        const merged = mergeVideoSamples(existing?.samples ?? [], incoming);
        added += merged.length - (existing?.samples.length ?? 0);
        await this.buckets.put({
          identityKey: identity.key,
          modelId,
          bucketStartUs,
          hostname: origin.hostname,
          samples: merged,
        });
      }
      const record = (await this.table.get(identity.key)) ?? newRecord(identity, origin, 'auto');
      await this.table.put({
        ...record,
        sourceUrl: origin.sourceUrl,
        hostname: origin.hostname,
        timestamp: Date.now(),
        sampleCounts: { ...record.sampleCounts, [modelId]: (record.sampleCounts[modelId] ?? 0) + added },
      });
    });
  }

  /**
   * Drops a video's samples once the media behind its key changed length (a trim, a re-upload under
   * one URL), keeping its Forced Visibility and adopting the new duration.
   */
  async purgeSamples(identity: PersistentVideoIdentity): Promise<void> {
    if (isCacheDisabled) return;
    await mediaCacheDb.transaction('rw', this.table, this.buckets, () => this.purgeSamplesWithin(identity));
  }

  private async purgeSamplesWithin(identity: PersistentVideoIdentity): Promise<void> {
    await this.buckets.where('identityKey').equals(identity.key).delete();
    await this.table
      .where('identityKey')
      .equals(identity.key)
      .modify(record => {
        record.durationSec = identity.durationSec;
        record.sampleCounts = {};
      });
  }

  async updateForcedVisibility(
    identity: PersistentVideoIdentity,
    origin: VideoPredictionOrigin,
    forcedVisibility: ForcedVisibility,
  ): Promise<void> {
    if (isCacheDisabled) return;
    await mediaCacheDb.transaction('rw', this.table, async () => {
      const existing = await this.table.get(identity.key);
      if (!existing && forcedVisibility === 'auto') return;
      await this.table.put(
        existing ? { ...existing, forcedVisibility } : newRecord(identity, origin, forcedVisibility),
      );
    });
  }

  async touchAccessed(identityKey: string): Promise<void> {
    if (isCacheDisabled) return;
    await this.table
      .where('identityKey')
      .equals(identityKey)
      .modify(record => {
        record.cacheMetadata.accessedAt = Date.now();
      });
  }

  override async delete(identityKey: string): Promise<void> {
    await this.deleteVideos([identityKey]);
  }

  override async deleteByHostname(hostname: string): Promise<number> {
    if (isCacheDisabled) return 0;
    const effectiveHostname = getEffectiveHostname(hostname);
    return mediaCacheDb.transaction('rw', this.table, this.buckets, async () => {
      await this.buckets.where('hostname').equals(effectiveHostname).delete();
      return this.table.where('hostname').equals(effectiveHostname).delete();
    });
  }

  override async deleteExpired(): Promise<number> {
    if (isCacheDisabled) return 0;
    const expired = await this.table.filter(record => !isVideoCacheFresh(record)).primaryKeys();
    await this.deleteVideos(expired);
    return expired.length;
  }

  override async clear(): Promise<void> {
    if (isCacheDisabled) return;
    await mediaCacheDb.transaction('rw', this.table, this.buckets, async () => {
      await this.buckets.clear();
      await this.table.clear();
    });
  }

  private async deleteVideos(identityKeys: string[]): Promise<void> {
    if (isCacheDisabled || identityKeys.length === 0) return;
    await mediaCacheDb.transaction('rw', this.table, this.buckets, async () => {
      await this.buckets.where('identityKey').anyOf(identityKeys).delete();
      await this.table.bulkDelete(identityKeys);
    });
  }
}
