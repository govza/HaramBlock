import { predictionsDb } from "./db";
import { getEffectiveHostname } from "./hostnameUtil";
import { ICacheMetadata, IImagePrediction } from "@/utils/types";

/**
 * PredictionCache - Data model and repository for cached prediction records
 * Combines entity model with data access methods
 */
export class PredictionCache implements IImagePrediction {
  hostname: string;
  src: string;
  imageWidth: number;
  imageHeight: number;
  timestamp: number;
  predictions: IImagePrediction['predictions'];
  cacheMetadata: ICacheMetadata;

  constructor(record: IImagePrediction) {
    this.hostname = record.hostname;
    this.src = record.src;
    this.imageWidth = record.imageWidth;
    this.imageHeight = record.imageHeight;
    this.predictions = record.predictions;
    this.timestamp = record.timestamp;
    this.cacheMetadata = record.cacheMetadata;
  }

  async save(): Promise<string> {
    try {
      if (this.src) {
        await predictionsDb.predictions.put(this.serialize());
        return this.src;
      } else {
        const src = await predictionsDb.predictions.add(this.serialize());
        this.src = src;
        return src;
      }
    } catch (error) {
      throw new Error('Failed to save prediction record', { cause: error });
    }
  }

  async delete(): Promise<void> {
    if (this.src) {
      try {
        await predictionsDb.predictions.delete(this.src);
      } catch (error) {
        throw new Error('Failed to delete prediction record', { cause: error });
      }
    }
  }

  serialize(): IImagePrediction {
    return {
      src: this.src,
      hostname: this.hostname,
      timestamp: this.timestamp,
      imageWidth: this.imageWidth,
      imageHeight: this.imageHeight,
      predictions: this.predictions,
      cacheMetadata: this.cacheMetadata,
    };
  }

  /**
   * Check if the cached prediction is still valid based on cache metadata
   * @returns true if cache is valid, false if expired
   */
  isValid(): boolean {
    const now = Date.now();

    // Check if explicitly expired
    if (this.cacheMetadata.expires && now > this.cacheMetadata.expires) {
      return false;
    }

    // Check max-age
    if (this.cacheMetadata.maxAge) {
      const ageInSeconds = (now - this.cacheMetadata.createdAt) / 1000;
      if (ageInSeconds > this.cacheMetadata.maxAge) {
        return false;
      }
    }

    // If no specific cache rules, consider valid
    return true;
  }

  /**
   * Update the access time for this cache entry
   */
  updateAccessTime(): void {
    this.cacheMetadata.accessedAt = Date.now();
  }

  /**
   * Get the remaining TTL in seconds
   * @returns TTL in seconds, or null if no expiration set
   */
  getRemainingTTL(): number | null {
    const now = Date.now();

    if (this.cacheMetadata.expires) {
      return Math.max(0, Math.floor((this.cacheMetadata.expires - now) / 1000));
    }

    if (this.cacheMetadata.maxAge) {
      const ageInSeconds = (now - this.cacheMetadata.createdAt) / 1000;
      return Math.max(0, this.cacheMetadata.maxAge - ageInSeconds);
    }

    return null;
  }

  static async findBySrc(src: string): Promise<PredictionCache[]> {
    const records = await predictionsDb.predictions.where('src').equals(src).toArray();
    return records.map(record => new PredictionCache(record));
  }

  static async findByHostname(hostname: string): Promise<PredictionCache[]> {
    const effectiveHostname = getEffectiveHostname(hostname);
    const records = await predictionsDb.predictions.where('hostname').equals(effectiveHostname).toArray();
    return records.map(record => new PredictionCache(record));
  }

  /**
   * Find valid (non-expired) cached predictions by hostname
   * @param hostname - The hostname to search for
   * @returns Promise resolving to array of valid prediction cache entries
   */
  static async findValidByHostname(hostname: string): Promise<PredictionCache[]> {
    const allRecords = await this.findByHostname(hostname);
    return allRecords.filter(record => record.isValid());
  }

  static async findBySrcAndHostname(src: string, hostname: string): Promise<PredictionCache[]> {
    const effectiveHostname = getEffectiveHostname(hostname);
    const records = await predictionsDb.predictions
      .where('src').equals(src)
      .and(record => record.hostname === effectiveHostname)
      .toArray();
    return records.map(record => new PredictionCache(record));
  }

  static async findRecent(limit: number = 50): Promise<PredictionCache[]> {
    const records = await predictionsDb.predictions
      .orderBy('timestamp')
      .reverse()
      .limit(limit)
      .toArray();
    return records.map(record => new PredictionCache(record));
  }

  static async create(prediction: PredictionCache, hostname: string): Promise<PredictionCache> {
    const effectiveHostname = getEffectiveHostname(hostname);
    const now = Date.now();

    const predictionRecord = new PredictionCache({
      ...prediction,
      hostname: effectiveHostname,
      timestamp: now,
      cacheMetadata: {
        ...prediction.cacheMetadata,
        createdAt: now,
        accessedAt: now,
      }
    });
    await predictionRecord.save();
    return predictionRecord;
  }

  /**
   * Create cache metadata from HTTP response headers
   * @param headers - HTTP response headers
   * @param contentType - MIME type of the image
   * @param contentLength - Size of the image in bytes
   * @returns Cache metadata object
   */
  static createCacheMetadata(
    headers: Record<string, string> = {},
    contentType?: string,
    contentLength?: number
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

  static async deleteByHostname(hostname: string): Promise<number> {
    const effectiveHostname = getEffectiveHostname(hostname);
    return await predictionsDb.predictions.where('hostname').equals(effectiveHostname).delete();
  }

  static async deleteOlderThan(timestamp: number): Promise<number> {
    return await predictionsDb.predictions.where('timestamp').below(timestamp).delete();
  }

  /**
   * Delete expired cache entries based on cache metadata
   * @returns Promise resolving to number of deleted records
   */
  static async deleteExpired(): Promise<number> {
    const allRecords = await predictionsDb.predictions.toArray();
    const expiredIds: string[] = [];

    for (const record of allRecords) {
      const predictionCache = new PredictionCache(record);
      if (!predictionCache.isValid()) {
        expiredIds.push(record.src);
      }
    }

    if (expiredIds.length > 0) {
      return await predictionsDb.predictions.where('src').anyOf(expiredIds).delete();
    }

    return 0;
  }

  static async count(): Promise<number> {
    return await predictionsDb.predictions.count();
  }

  static async countByHostname(hostname: string): Promise<number> {
    const effectiveHostname = getEffectiveHostname(hostname);
    return await predictionsDb.predictions.where('hostname').equals(effectiveHostname).count();
  }
}
