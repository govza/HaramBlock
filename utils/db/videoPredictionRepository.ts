import { MAX_VERDICT_TIMELINE_ENTRIES } from '@/utils/constants/video';
import { isCacheDisabled } from '@/utils/db/cacheAvailability';
import { mediaCacheDb } from '@/utils/db/db';
import { HostScopedCacheRepository } from '@/utils/db/hostScopedCacheRepository';
import { isValidPrediction } from '@/utils/db/predictionValidity';
import { getEffectiveHostname } from '@/utils/hostnameUtil';

import type { ForcedVisibility, ICacheMetadata, IStoredVideoSample, IVideoPredictionRecord } from '@/utils/types';

export function mergeVideoSamples(
  existing: readonly IStoredVideoSample[],
  incoming: readonly IStoredVideoSample[],
  maxSamples = MAX_VERDICT_TIMELINE_ENTRIES,
): IStoredVideoSample[] {
  const byPoint = new Map<number, IStoredVideoSample>();
  for (const sample of existing) byPoint.set(sample.pointUs, sample);
  for (const sample of incoming) byPoint.set(sample.pointUs, sample);
  const merged = [...byPoint.values()].sort((a, b) => a.pointUs - b.pointUs);
  return merged.length > maxSamples ? merged.slice(merged.length - maxSamples) : merged;
}

export const allVideoSamples = (record: IVideoPredictionRecord): IStoredVideoSample[] =>
  Object.values(record.samplesByModel).flat();

export interface VideoPredictionOrigin {
  sourceUrl: string;
  hostname: string;
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
    modelId: string,
    origin: VideoPredictionOrigin,
    samples: readonly IStoredVideoSample[],
  ): Promise<void> {
    if (isCacheDisabled || samples.length === 0) return;
    await mediaCacheDb.transaction('rw', this.table, async () => {
      const existing = await this.table.get(videoUrl);
      const samplesByModel = existing?.samplesByModel ?? {};
      const record: IVideoPredictionRecord = {
        videoUrl,
        sourceUrl: origin.sourceUrl,
        hostname: origin.hostname,
        forcedVisibility: existing?.forcedVisibility ?? 'auto',
        timestamp: Date.now(),
        cacheMetadata: existing?.cacheMetadata ?? origin.cacheMetadata,
        samplesByModel: { ...samplesByModel, [modelId]: mergeVideoSamples(samplesByModel[modelId] ?? [], samples) },
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
            forcedVisibility,
            timestamp: Date.now(),
            cacheMetadata: origin.cacheMetadata,
            samplesByModel: {},
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
        record.samplesByModel = {};
      });
  }
}
