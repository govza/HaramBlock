import { ImagePredictionRepository } from '@/utils/db/imagePredictionRepository';
import { VideoPredictionRepository } from '@/utils/db/videoPredictionRepository';
import { getLogger } from '@/utils/telemetry';

const log = getLogger('cacheEvictionService');

export class CacheEvictionService {
  private readonly repositories = [new ImagePredictionRepository(), new VideoPredictionRepository()];

  async evictExpired(): Promise<void> {
    try {
      const [images, videos] = await Promise.all(this.repositories.map(repository => repository.deleteExpired()));
      log.debug('cache.evicted', { images, videos });
    } catch (error) {
      log.warn('cache.evict.failed', { error });
    }
  }
}
