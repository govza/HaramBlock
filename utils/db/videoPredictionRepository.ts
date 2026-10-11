import Dexie from 'dexie';

import { isCacheDisabled } from '@/utils/db/cacheAvailability';
import { mediaCacheDb } from '@/utils/db/db';
import { HostScopedCacheRepository } from '@/utils/db/hostScopedCacheRepository';
import { isValidPrediction } from '@/utils/db/predictionValidity';
import { getEffectiveHostname } from '@/utils/hostnameUtil';

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

const bucketKey = (videoUrl: string, modelId: string, bucketStartUs: number): [string, string, number] => [
  videoUrl,
  modelId,
  bucketStartUs,
];

export class VideoPredictionRepository extends HostScopedCacheRepository<IVideoPredictionRecord> {
  private readonly buckets = mediaCacheDb.videoSamples;

  constructor() {
    super(mediaCacheDb.videoPredictions);
  }

  async findValidByVideoUrl(videoUrl: string): Promise<IVideoPredictionRecord | undefined> {
    if (isCacheDisabled) return undefined;
    const record = await this.table.get(videoUrl);
    if (!record || !isVideoCacheFresh(record)) return undefined;
    return record;
  }

  async readSamples(videoUrl: string, modelId: string): Promise<IStoredVideoSample[]> {
    if (isCacheDisabled) return [];
    const buckets = await this.buckets
      .where('[videoUrl+modelId+bucketStartUs]')
      .between([videoUrl, modelId, Dexie.minKey], [videoUrl, modelId, Dexie.maxKey])
      .toArray();
    return buckets.flatMap(bucket => bucket.samples);
  }

  async mergeSamples(
    videoUrl: string,
    modelId: string,
    origin: VideoPredictionOrigin,
    samples: readonly IStoredVideoSample[],
  ): Promise<void> {
    if (isCacheDisabled || samples.length === 0) return;
    await mediaCacheDb.transaction('rw', this.table, this.buckets, async () => {
      const stored = await this.table.get(videoUrl);
      if (stored && !isVideoCacheFresh(stored)) {
        await this.buckets.where('videoUrl').equals(videoUrl).delete();
        await this.table.delete(videoUrl);
      }
      let added = 0;
      for (const [bucketStartUs, incoming] of groupByBucket(samples)) {
        const existing = await this.buckets.get(bucketKey(videoUrl, modelId, bucketStartUs));
        const merged = mergeVideoSamples(existing?.samples ?? [], incoming);
        added += merged.length - (existing?.samples.length ?? 0);
        await this.buckets.put({ videoUrl, modelId, bucketStartUs, hostname: origin.hostname, samples: merged });
      }
      const existing = await this.table.get(videoUrl);
      const sampleCounts = existing?.sampleCounts ?? {};
      await this.table.put({
        videoUrl,
        sourceUrl: origin.sourceUrl,
        hostname: origin.hostname,
        forcedVisibility: existing?.forcedVisibility ?? 'auto',
        timestamp: Date.now(),
        cacheMetadata: existing?.cacheMetadata ?? origin.cacheMetadata,
        sampleCounts: { ...sampleCounts, [modelId]: (sampleCounts[modelId] ?? 0) + added },
      });
    });
  }

  async updateForcedVisibility(
    videoUrl: string,
    origin: VideoPredictionOrigin,
    forcedVisibility: ForcedVisibility,
  ): Promise<void> {
    if (isCacheDisabled) return;
    await mediaCacheDb.transaction('rw', this.table, async () => {
      const existing = await this.table.get(videoUrl);
      if (!existing && forcedVisibility === 'auto') return;
      const record: IVideoPredictionRecord = existing
        ? { ...existing, forcedVisibility }
        : {
            videoUrl,
            sourceUrl: origin.sourceUrl,
            hostname: origin.hostname,
            forcedVisibility,
            timestamp: Date.now(),
            cacheMetadata: origin.cacheMetadata,
            sampleCounts: {},
          };
      await this.table.put(record);
    });
  }

  async touchAccessed(videoUrl: string): Promise<void> {
    if (isCacheDisabled) return;
    await this.table
      .where('videoUrl')
      .equals(videoUrl)
      .modify(record => {
        record.cacheMetadata.accessedAt = Date.now();
      });
  }

  override async delete(videoUrl: string): Promise<void> {
    await this.deleteVideos([videoUrl]);
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

  private async deleteVideos(videoUrls: string[]): Promise<void> {
    if (isCacheDisabled || videoUrls.length === 0) return;
    await mediaCacheDb.transaction('rw', this.table, this.buckets, async () => {
      await this.buckets.where('videoUrl').anyOf(videoUrls).delete();
      await this.table.bulkDelete(videoUrls);
    });
  }
}
