import { isCacheDisabled } from '@/utils/db/cacheAvailability';
import { mediaCacheDb } from '@/utils/db/db';
import { HostScopedCacheRepository } from '@/utils/db/hostScopedCacheRepository';
import { isValidPrediction } from '@/utils/db/predictionValidity';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { type ForcedVisibility, type IStoredImagePrediction } from '@/utils/types';

/**
 * Repository for managing image prediction cache records
 * Provides database operations specific to image prediction cache
 */
export class ImagePredictionRepository extends HostScopedCacheRepository<IStoredImagePrediction> {
  constructor() {
    super(mediaCacheDb.imagePredictions);
  }

  /**
   * Find predictions by src URL
   */
  async findBySrc(src: string): Promise<IStoredImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    return this.where('src').equals(src).toArray();
  }

  async findValidBySrc(src: string): Promise<IStoredImagePrediction | undefined> {
    const [stored] = await this.findBySrc(src);
    return stored && isValidPrediction(stored) ? stored : undefined;
  }

  /**
   * Find predictions by hostname
   */
  async findByHostname(hostname: string): Promise<IStoredImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    const effectiveHostname = getEffectiveHostname(hostname);
    return this.where('hostname').equals(effectiveHostname).toArray();
  }

  /**
   * Find valid (non-expired) predictions by hostname
   */
  async findValidByHostname(hostname: string): Promise<IStoredImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    const allRecords = await this.findByHostname(hostname);
    return allRecords.filter(record => isValidPrediction(record));
  }

  /**
   * Find all valid (non-expired) predictions
   */
  async findAllValid(): Promise<IStoredImagePrediction[]> {
    if (isCacheDisabled) {
      return [];
    }
    const allRecords = await this.findAll();
    return allRecords.filter(record => isValidPrediction(record));
  }

  /**
   * Find predictions by both src and hostname
   */
  async findBySrcAndHostname(src: string, hostname: string): Promise<IStoredImagePrediction[]> {
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
  async findRecent(limit: number = 50): Promise<IStoredImagePrediction[]> {
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
  async storeOwn(prediction: IStoredImagePrediction): Promise<void> {
    if (isCacheDisabled) return;
    try {
      await this.table.put(prediction);
    } catch (error) {
      throw new Error('Failed to save prediction record', { cause: error });
    }
  }

  /**
   * Stores the user's toggle and resolves whether the row became `pending`: only a flip on a row that
   * already carries a Report Status does, so a row rejected or migrated when written stays unreported.
   */
  async setForcedVisibility(src: string, forcedVisibility: ForcedVisibility, changedAt: number): Promise<boolean> {
    if (isCacheDisabled) return false;
    let becamePending = false;
    await this.table
      .where('src')
      .equals(src)
      .modify(row => {
        const isFlip = row.forcedVisibility !== forcedVisibility;
        row.forcedVisibility = forcedVisibility;
        if (!isFlip || row.reportStatus === undefined) return;
        row.reportStatus = 'pending';
        row.reportChangedAt = changedAt;
        becamePending = true;
      });
    return becamePending;
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
