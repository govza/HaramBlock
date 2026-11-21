import { isCacheDisabled } from '@/utils/db/cacheAvailability';
import { mediaCacheDb } from '@/utils/db/db';
import { HostScopedCacheRepository } from '@/utils/db/hostScopedCacheRepository';
import { isValidPrediction } from '@/utils/db/predictionValidity';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { type ForcedVisibility, type IImagePrediction } from '@/utils/types';

/**
 * Repository for managing image prediction cache records
 * Provides database operations specific to image prediction cache
 */
export class ImagePredictionRepository extends HostScopedCacheRepository<IImagePrediction> {
  constructor() {
    super(mediaCacheDb.imagePredictions);
  }

  /**
   * Find predictions by src URL
   */
  async findBySrc(src: string): Promise<IImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    return this.where('src').equals(src).toArray();
  }

  async findValidBySrc(src: string): Promise<IImagePrediction | undefined> {
    const [stored] = await this.findBySrc(src);
    return stored && isValidPrediction(stored) ? stored : undefined;
  }

  /**
   * Find predictions by hostname
   */
  async findByHostname(hostname: string): Promise<IImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    const effectiveHostname = getEffectiveHostname(hostname);
    return this.where('hostname').equals(effectiveHostname).toArray();
  }

  /**
   * Find valid (non-expired) predictions by hostname
   */
  async findValidByHostname(hostname: string): Promise<IImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    const allRecords = await this.findByHostname(hostname);
    return allRecords.filter(record => isValidPrediction(record));
  }

  /**
   * Find all valid (non-expired) predictions
   */
  async findAllValid(): Promise<IImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    const allRecords = await this.findAll();
    return allRecords.filter(record => isValidPrediction(record));
  }

  /**
   * Find predictions by both src and hostname
   */
  async findBySrcAndHostname(src: string, hostname: string): Promise<IImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    const effectiveHostname = getEffectiveHostname(hostname);
    return this.where('src')
      .equals(src)
      .and(record => record.hostname === effectiveHostname)
      .toArray();
  }

  /**
   * Find recent predictions with limit
   */
  async findRecent(limit: number = 50): Promise<IImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    return this.table.orderBy('timestamp').reverse().limit(limit).toArray();
  }

  /**
   * Delete predictions older than timestamp
   */
  async deleteOlderThan(timestamp: number): Promise<number> {
    if (isCacheDisabled) {
      return 0;
    }
    return this.where('timestamp').below(timestamp).delete();
  }

  /**
   * Writes the row of a locally inferred prediction, replacing whatever the src held.
   */
  async storeOwn(prediction: IImagePrediction): Promise<void> {
    if (isCacheDisabled) return;
    try {
      await this.table.put(prediction);
    } catch (error) {
      throw new Error('Failed to save prediction record', { cause: error });
    }
  }

  async setForcedVisibility(src: string, forcedVisibility: ForcedVisibility): Promise<void> {
    if (isCacheDisabled) return;
    await this.table.update(src, { forcedVisibility });
  }

  async touch(src: string, accessedAt: number): Promise<void> {
    if (isCacheDisabled) return;
    await this.table.update(src, { 'cacheMetadata.accessedAt': accessedAt });
  }

  async rehome(src: string, hostname: string, accessedAt: number): Promise<void> {
    if (isCacheDisabled) return;
    await this.table.update(src, { hostname, 'cacheMetadata.accessedAt': accessedAt });
  }
}
