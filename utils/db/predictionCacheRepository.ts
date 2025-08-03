import { BaseRepository } from '@/utils/db/baseRepository';
import { predictionsDb } from '@/utils/db/db';
import { getEffectiveHostname } from '@/utils/db/hostnameUtil';
import { logger } from '@/utils/logger';
import { type IImagePrediction, type ICacheMetadata } from '@/utils/types';

const isCacheDisabled = import.meta.env.MODE === 'nocache';
if (isCacheDisabled) {
  logger
    .withTag('predictionCacheRepository')
    .info('Prediction cache is disabled');
}

/**
 * Repository for managing prediction cache records
 * Provides database operations specific to prediction cache
 */
export class PredictionCacheRepository extends BaseRepository<
  IImagePrediction,
  string
> {
  constructor() {
    super(predictionsDb.predictions);
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
    return allRecords.filter(record => this.isValidPrediction(record));
  }

  /**
   * Find predictions by both src and hostname
   */
  async findBySrcAndHostname(
    src: string,
    hostname: string,
  ): Promise<IImagePrediction[]> {
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
  async createPrediction(
    prediction: IImagePrediction,
    hostname: string,
  ): Promise<IImagePrediction> {
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
    const effectiveHostname = getEffectiveHostname(hostname);
    return this.where('hostname').equals(effectiveHostname).delete();
  }

  /**
   * Delete predictions older than timestamp
   */
  async deleteOlderThan(timestamp: number): Promise<number> {
    return this.where('timestamp').below(timestamp).delete();
  }

  /**
   * Delete expired cache entries based on cache metadata
   */
  async deleteExpired(): Promise<number> {
    const allRecords = await this.table.toArray();
    const expiredIds: string[] = [];

    for (const record of allRecords) {
      if (!this.isValidPrediction(record)) {
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
        await predictionsDb.predictions.put(prediction);
        return prediction.src;
      } else {
        const src = await predictionsDb.predictions.add(prediction);
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

  /**
   * Check if a cached prediction is still valid based on cache metadata
   * @param prediction - The prediction record to validate
   * @returns true if cache is valid, false if expired
   */
  private isValidPrediction(prediction: IImagePrediction): boolean {
    const now = Date.now();

    // Check if explicitly expired
    if (
      prediction.cacheMetadata.expires &&
      now > prediction.cacheMetadata.expires
    ) {
      return false;
    }

    // Check max-age
    if (prediction.cacheMetadata.maxAge) {
      const ageInSeconds = (now - prediction.cacheMetadata.createdAt) / 1000;
      if (ageInSeconds > prediction.cacheMetadata.maxAge) {
        return false;
      }
    }

    // If no specific cache rules, consider valid
    return true;
  }

  /**
   * Create cache metadata from HTTP response headers
   * @param headers - HTTP response headers
   * @param contentType - MIME type of the image
   * @param contentLength - Size of the image in bytes
   * @returns Cache metadata object
   */
  createCacheMetadata(
    headers: Record<string, string> = {},
    contentType?: string,
    contentLength?: number,
  ): ICacheMetadata {
    const now = Date.now();
    const cacheControl = headers['cache-control'] || headers['Cache-Control'];
    const etag = headers['etag'] || headers['ETag'];
    const lastModified = headers['last-modified'] || headers['Last-Modified'];
    const expires = headers['expires'] || headers['Expires'];

    let maxAge: number | undefined;
    let expiresTimestamp: number | undefined;

    // Parse Cache-Control max-age
    if (cacheControl) {
      const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
      if (maxAgeMatch && maxAgeMatch[1]) {
        maxAge = parseInt(maxAgeMatch[1], 10);
      }
    }

    // Parse Expires header
    if (expires) {
      expiresTimestamp = new Date(expires).getTime();
    }

    // Parse Last-Modified header
    let lastModifiedTimestamp: number | undefined;
    if (lastModified) {
      lastModifiedTimestamp = new Date(lastModified).getTime();
    }

    return {
      cacheControl,
      etag,
      lastModified: lastModifiedTimestamp,
      expires: expiresTimestamp,
      maxAge,
      createdAt: now,
      accessedAt: now,
      contentType,
      contentLength,
    };
  }
}
