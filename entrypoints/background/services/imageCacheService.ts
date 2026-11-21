import { ImagePredictionRepository } from '@/utils/db/imagePredictionRepository';
import { ATTR, getLogger } from '@/utils/telemetry';
import { type ForcedVisibility, type IImagePrediction } from '@/utils/types';

const log = getLogger('imageCacheService');

/**
 * ImageCacheService handles business logic for image prediction cache
 * Coordinates between controllers and data layer for cached image predictions
 */
export class ImageCacheService {
  private repository: ImagePredictionRepository;

  constructor() {
    try {
      this.repository = new ImagePredictionRepository();
    } catch {
      log.error('cache.init.failed');
      throw new Error('Failed to initialize ImagePredictionRepository');
    }
  }

  /**
   * Caches a prediction this install inferred, replacing whatever its src held.
   */
  async storeOwn(prediction: IImagePrediction): Promise<void> {
    try {
      await this.repository.storeOwn(prediction);
    } catch (error) {
      log.error('cache.write.failed', { error });
      throw error;
    }
  }

  /**
   * Retrieve cached predictions for a given hostname
   * @param hostname - The hostname to retrieve predictions for
   * @returns Promise resolving to array of cached predictions
   */
  async getCachedPredictionsByHostname(hostname: string): Promise<IImagePrediction[]> {
    if (!hostname || !hostname.trim()) {
      throw new Error('Hostname is required');
    }

    try {
      // Get only valid (non-expired) predictions
      const predictions = await this.repository.findValidByHostname(hostname);

      predictions.forEach(prediction => this.touch(prediction.src));
      return predictions;
    } catch (error) {
      log.error('cache.read_by_hostname.failed', { [ATTR.hostname]: hostname, error });
      throw error;
    }
  }

  async getCachedPredictionsBySrc(src: string): Promise<IImagePrediction[]> {
    if (!src || !src.trim()) {
      throw new Error('Source URL is required');
    }

    try {
      // Find prediction by src URL
      const predictions = await this.repository.findBySrc(src);
      return predictions;
    } catch (error) {
      log.error('cache.read_by_src.failed', { [ATTR.src]: src, error });
      throw error;
    }
  }

  async findValidBySrc(src: string): Promise<IImagePrediction | undefined> {
    return this.repository.findValidBySrc(src);
  }

  /**
   * Moves a verdict under `hostname` and refreshes its access time so the next page load on that
   * host seeds it. Fire-and-forget: a failed write only costs a later lookup.
   */
  rehome(prediction: IImagePrediction, hostname: string): IImagePrediction {
    const accessedAt = Date.now();
    this.repository.rehome(prediction.src, hostname, accessedAt).catch((error: unknown) => {
      log.warn('cache.rehome.failed', { [ATTR.src]: prediction.src, error });
    });
    return { ...prediction, hostname, cacheMetadata: { ...prediction.cacheMetadata, accessedAt } };
  }

  /**
   * Refreshes a cached prediction's access time. Fire-and-forget: a failed write changes no verdict.
   */
  touch(src: string): void {
    this.repository.touch(src, Date.now()).catch((error: unknown) => {
      log.warn('cache.access_time.update.failed', { [ATTR.src]: src, error });
    });
  }

  async setForcedVisibility(src: string, forcedVisibility: ForcedVisibility): Promise<void> {
    try {
      await this.repository.setForcedVisibility(src, forcedVisibility);
    } catch (error) {
      log.error('cache.toggle_state.update.failed', { [ATTR.src]: src, error });
      throw error;
    }
  }
}
