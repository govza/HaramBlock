import { BaseRepository } from '@/utils/db/baseRepository';
import { imageDb, isIncognito } from '@/utils/db/db';
import { isValidPrediction } from '@/utils/db/predictionValidity';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { type IImagePrediction } from '@/utils/types';

// Cache is disabled in private browsing (IndexedDB doesn't work) or no-cache mode
const isCacheDisabled = isIncognito || import.meta.env.MODE === 'no-cache';

/**
 * Repository for managing image prediction cache records
 * Provides database operations specific to image prediction cache
 */
export class ImageCacheRepository extends BaseRepository<IImagePrediction, string> {
  constructor() {
    super(imageDb.predictions);
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
   * Create a new prediction cache record
   */
  async createPrediction(prediction: IImagePrediction, hostname: string): Promise<IImagePrediction> {
    const effectiveHostname = getEffectiveHostname(hostname);
    const now = Date.now();

    const predictionRecord: IImagePrediction = {
      ...prediction,
      hostname: effectiveHostname,
      timestamp: now,
      cacheMetadata: {
        ...prediction.cacheMetadata,
        createdAt: now,
        accessedAt: now,
      },
    };

    await this.save(predictionRecord);
    return predictionRecord;
  }

  /**
   * Delete predictions by hostname
   */
  async deleteByHostname(hostname: string): Promise<number> {
    if (isCacheDisabled) {
      return 0;
    }
    const effectiveHostname = getEffectiveHostname(hostname);
    return this.where('hostname').equals(effectiveHostname).delete();
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
   * Delete expired cache entries based on cache metadata
   */
  async deleteExpired(): Promise<number> {
    if (isCacheDisabled) {
      return 0;
    }
    const allRecords = await this.table.toArray();
    const expiredIds: string[] = [];

    for (const record of allRecords) {
      if (!isValidPrediction(record)) {
        expiredIds.push(record.src);
      }
    }

    if (expiredIds.length > 0) {
      return this.where('src').anyOf(expiredIds).delete();
    }

    return 0;
  }

  /**
   * Count predictions by hostname
   */
  async countByHostname(hostname: string): Promise<number> {
    if (isCacheDisabled) {
      return 0;
    }
    const effectiveHostname = getEffectiveHostname(hostname);
    return this.where('hostname').equals(effectiveHostname).count();
  }

  /**
   * Save a prediction record to the database
   * @param prediction - The prediction record to save
   * @returns The src key of the saved record
   */
  async savePrediction(prediction: IImagePrediction): Promise<string> {
    // Don't save when cache is disabled
    if (isCacheDisabled) {
      return prediction.src;
    }

    try {
      if (prediction.src) {
        await imageDb.predictions.put(prediction);
        return prediction.src;
      } else {
        const src = await imageDb.predictions.add(prediction);
        return src;
      }
    } catch (error) {
      throw new Error('Failed to save prediction record', { cause: error });
    }
  }

  /**
   * Update the access time for a cache entry
   * @param prediction - The prediction record to update
   * @returns Updated prediction record
   */
  updateAccessTime(prediction: IImagePrediction): IImagePrediction {
    return {
      ...prediction,
      cacheMetadata: {
        ...prediction.cacheMetadata,
        accessedAt: Date.now(),
      },
    };
  }
}
