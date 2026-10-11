import { getCurrentModelId } from '@inference-runtime';

import { clampMaxAge } from '@/utils/cacheUtils';
import { VideoPredictionRepository } from '@/utils/db/videoPredictionRepository';
import { ATTR, getLogger } from '@/utils/telemetry';
import {
  EMPTY_CACHED_VIDEO_PREDICTIONS,
  type ForcedVisibility,
  type ICachedVideoPredictions,
  type ICacheMetadata,
  type IStoredVideoSample,
} from '@/utils/types';

const log = getLogger('videoPredictionCacheService');

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_ENTRY_THRESHOLD = 50;
const UNCACHEABLE_URL_PREFIX = 'srcobject:';

export interface VideoSampleOrigin {
  sourceUrl: string;
  hostname: string;
}

interface PendingWrite extends VideoSampleOrigin {
  videoUrl: string;
  modelId: string;
  samples: IStoredVideoSample[];
}

function currentModelId(): string {
  return getCurrentModelId() ?? 'unknown';
}

function defaultCacheMetadata(): ICacheMetadata {
  const now = Date.now();
  const maxAge = clampMaxAge(null);
  return { createdAt: now, accessedAt: now, maxAge, cacheControl: `max-age=${maxAge}`, contentType: 'video/frame' };
}

export function isCacheableVideoUrl(videoUrl: string): boolean {
  return videoUrl.length > 0 && !videoUrl.startsWith(UNCACHEABLE_URL_PREFIX);
}

export class VideoPredictionCacheService {
  private readonly repository = new VideoPredictionRepository();
  private readonly pending = new Map<string, PendingWrite>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  publish(videoUrl: string, origin: VideoSampleOrigin, samples: readonly IStoredVideoSample[]): void {
    if (samples.length === 0 || !isCacheableVideoUrl(videoUrl)) return;
    const modelId = currentModelId();
    const key = `${videoUrl}\n${modelId}`;
    const write = this.pending.get(key) ?? { videoUrl, modelId, ...origin, samples: [] };
    write.samples.push(...samples);
    this.pending.set(key, write);
    if (write.samples.length >= FLUSH_ENTRY_THRESHOLD) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  async getCached(videoUrl: string): Promise<ICachedVideoPredictions> {
    if (!isCacheableVideoUrl(videoUrl)) return EMPTY_CACHED_VIDEO_PREDICTIONS;
    await this.flush();
    const record = await this.repository.findValidByVideoUrl(videoUrl);
    if (!record) return EMPTY_CACHED_VIDEO_PREDICTIONS;
    this.repository.touchAccessed(videoUrl).catch((error: unknown) => {
      log.warn('cache.touch.failed', { [ATTR.src]: videoUrl, error });
    });
    const samples = await this.repository.readSamples(videoUrl, currentModelId());
    return { samples, forcedVisibility: record.forcedVisibility };
  }

  async getForcedVisibility(videoUrl: string): Promise<ForcedVisibility> {
    if (!isCacheableVideoUrl(videoUrl)) return 'auto';
    const record = await this.repository.findValidByVideoUrl(videoUrl);
    return record?.forcedVisibility ?? 'auto';
  }

  async setForcedVisibility(
    videoUrl: string,
    origin: VideoSampleOrigin,
    forcedVisibility: ForcedVisibility,
  ): Promise<void> {
    if (!isCacheableVideoUrl(videoUrl)) return;
    await this.flush();
    await this.repository.updateForcedVisibility(
      videoUrl,
      { ...origin, cacheMetadata: defaultCacheMetadata() },
      forcedVisibility,
    );
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const writes = [...this.pending.values()];
    this.pending.clear();
    for (const write of writes) {
      try {
        await this.repository.mergeSamples(
          write.videoUrl,
          write.modelId,
          { sourceUrl: write.sourceUrl, hostname: write.hostname, cacheMetadata: defaultCacheMetadata() },
          write.samples,
        );
      } catch (error) {
        log.warn('cache.write.failed', { [ATTR.src]: write.videoUrl, error });
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }
}
