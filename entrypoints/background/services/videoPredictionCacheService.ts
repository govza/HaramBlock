import { getCurrentModelId } from '@inference-runtime';

import { clampMaxAge } from '@/utils/cacheUtils';
import { VideoPredictionRepository } from '@/utils/db/videoPredictionRepository';
import { ATTR, getLogger } from '@/utils/telemetry';
import {
  EMPTY_CACHED_VIDEO_PREDICTIONS,
  type ForcedVisibility,
  type ICachedFrameSample,
  type ICachedVideoPredictions,
  type ICacheMetadata,
  type IFramePrediction,
} from '@/utils/types';

const log = getLogger('videoPredictionCacheService');

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_ENTRY_THRESHOLD = 50;
const UNCACHEABLE_URL_PREFIX = 'srcobject:';

interface PendingWrite {
  sourceUrl: string;
  hostname: string;
  modelId: string;
  cacheMetadata: ICacheMetadata;
  samples: ICachedFrameSample[];
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

  record(prediction: IFramePrediction): void {
    if (prediction.frameIndex < 0 || !isCacheableVideoUrl(prediction.videoUrl)) return;
    const modelId = currentModelId();
    const write = this.pending.get(prediction.videoUrl) ?? {
      sourceUrl: prediction.sourceUrl,
      hostname: prediction.hostname,
      modelId,
      cacheMetadata: prediction.cacheMetadata,
      samples: [],
    };
    write.modelId = modelId;
    write.samples.push({
      timestampSec: prediction.timestampSec,
      predictions: prediction.predictions,
      input: { width: prediction.width, height: prediction.height, maskTransform: prediction.maskTransform },
    });
    this.pending.set(prediction.videoUrl, write);
    if (write.samples.length >= FLUSH_ENTRY_THRESHOLD) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  async getCached(videoUrl: string): Promise<ICachedVideoPredictions> {
    if (!isCacheableVideoUrl(videoUrl)) return EMPTY_CACHED_VIDEO_PREDICTIONS;
    const record = await this.repository.findValidByVideoUrl(videoUrl);
    if (!record) return EMPTY_CACHED_VIDEO_PREDICTIONS;
    this.repository.touchAccessed(videoUrl).catch((error: unknown) => {
      log.warn('cache.touch.failed', { [ATTR.src]: videoUrl, error });
    });
    return { samples: record.samples, forcedVisibility: record.forcedVisibility };
  }

  async setForcedVisibility(
    videoUrl: string,
    origin: { sourceUrl: string; hostname: string },
    forcedVisibility: ForcedVisibility,
  ): Promise<void> {
    if (!isCacheableVideoUrl(videoUrl)) return;
    await this.flush();
    await this.repository.updateForcedVisibility(
      videoUrl,
      { ...origin, modelId: currentModelId(), cacheMetadata: defaultCacheMetadata() },
      forcedVisibility,
    );
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const writes = [...this.pending];
    this.pending.clear();
    for (const [videoUrl, write] of writes) {
      try {
        await this.repository.mergeSamples(videoUrl, write, write.samples);
      } catch (error) {
        log.warn('cache.write.failed', { [ATTR.src]: videoUrl, error });
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
