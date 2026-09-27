import { MAX_VERDICT_TIMELINE_ENTRIES } from '@/utils/constants/video';
import { isCacheDisabled } from '@/utils/db/cacheAvailability';
import { mediaCacheDb } from '@/utils/db/db';
import { HostScopedCacheRepository } from '@/utils/db/hostScopedCacheRepository';
import { isValidPrediction } from '@/utils/db/predictionValidity';
import { getEffectiveHostname } from '@/utils/hostnameUtil';

import type { ForcedVisibility, ICachedFrameSample, ICacheMetadata, IVideoPredictionRecord } from '@/utils/types';

export function mergeFrameSamples(
  existing: readonly ICachedFrameSample[],
  incoming: readonly ICachedFrameSample[],
  maxSamples = MAX_VERDICT_TIMELINE_ENTRIES,
): ICachedFrameSample[] {
  const byTimestamp = new Map<number, ICachedFrameSample>();
  for (const sample of existing) byTimestamp.set(sample.timestampSec, sample);
  for (const sample of incoming) byTimestamp.set(sample.timestampSec, sample);
  const merged = [...byTimestamp.values()].sort((a, b) => a.timestampSec - b.timestampSec);
  return merged.length > maxSamples ? merged.slice(merged.length - maxSamples) : merged;
}

export interface VideoPredictionOrigin {
  sourceUrl: string;
  hostname: string;
  modelId: string;
  cacheMetadata: ICacheMetadata;
}

export class VideoPredictionRepository extends HostScopedCacheRepository<IVideoPredictionRecord> {
  constructor() {
    super(mediaCacheDb.videoPredictions);
  }

  async findValidByVideoUrl(videoUrl: string): Promise<IVideoPredictionRecord | undefined> {
    if (isCacheDisabled) return undefined;
    const record = await this.table.get(videoUrl);
    if (!record || !isValidPrediction(record)) return undefined;
    return record;
  }

  async mergeSamples(
    videoUrl: string,
    origin: VideoPredictionOrigin,
    samples: readonly ICachedFrameSample[],
  ): Promise<void> {
    if (isCacheDisabled || samples.length === 0) return;
    await mediaCacheDb.transaction('rw', this.table, async () => {
      const existing = await this.table.get(videoUrl);
      const record: IVideoPredictionRecord = {
        videoUrl,
        sourceUrl: origin.sourceUrl,
        hostname: origin.hostname,
        modelId: origin.modelId,
        forcedVisibility: existing?.forcedVisibility ?? 'auto',
        timestamp: Date.now(),
        cacheMetadata: existing?.cacheMetadata ?? origin.cacheMetadata,
        samples: mergeFrameSamples(existing?.samples ?? [], samples),
      };
      await this.table.put(record);
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
            modelId: origin.modelId,
            forcedVisibility,
            timestamp: Date.now(),
            cacheMetadata: origin.cacheMetadata,
            samples: [],
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

  async clearSamplesByHostname(hostname: string): Promise<number> {
    if (isCacheDisabled) return 0;
    return this.table
      .where('hostname')
      .equals(getEffectiveHostname(hostname))
      .modify(record => {
        record.samples = [];
      });
  }

  async deleteExpired(): Promise<number> {
    if (isCacheDisabled) return 0;
    const expiredKeys = (await this.table.toArray())
      .filter(record => !isValidPrediction(record))
      .map(record => record.videoUrl);
    if (expiredKeys.length === 0) return 0;
    return this.table.where('videoUrl').anyOf(expiredKeys).delete();
  }
}
