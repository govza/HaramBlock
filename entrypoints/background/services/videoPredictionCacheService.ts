import { getAvailableModels, getCurrentModelId } from '@inference-runtime';

import { clampMaxAge } from '@/utils/cacheUtils';
import { VideoPredictionRepository } from '@/utils/db/videoPredictionRepository';
import { cacheModelIdOf, type CacheModel } from '@/utils/inference/shared/modelRegistry';
import { selectAcrossVersions, type CachedSampleReader } from '@/utils/lookahead/sampleQuality';
import { getLogger, videoIdentityAttributes } from '@/utils/telemetry';
import {
  EMPTY_CACHED_VIDEO_PREDICTIONS,
  type ForcedVisibility,
  type ICachedVideoPredictions,
  type IVideoCacheOrigin,
  type ICacheMetadata,
  type IStoredVideoSample,
} from '@/utils/types';
import {
  isDurationMismatch,
  isPersistentIdentity,
  type PersistentVideoIdentity,
  type VideoIdentity,
} from '@/utils/videoIdentity';

const log = getLogger('videoPredictionCacheService');

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_ENTRY_THRESHOLD = 50;

/**
 * Samples buffered for one video identity and model until the next flush.
 */
interface PendingWrite {
  identity: PersistentVideoIdentity;
  model: CacheModel;
  origin: IVideoCacheOrigin;
  samples: IStoredVideoSample[];
}

function activeCacheModel(): CacheModel {
  const id = getCurrentModelId() ?? 'unknown';
  const model = getAvailableModels().find(candidate => candidate.id === id);
  if (!model) return { modelId: id, rank: 0 };
  return { modelId: cacheModelIdOf(model), rank: model.rank };
}

function rankOf(modelId: string, storedRanks: Record<string, number>): number {
  const shipped = getAvailableModels().find(model => cacheModelIdOf(model) === modelId);
  return shipped?.rank ?? storedRanks[modelId] ?? 0;
}

function defaultCacheMetadata(): ICacheMetadata {
  const now = Date.now();
  const maxAge = clampMaxAge(null);
  return { createdAt: now, accessedAt: now, maxAge, cacheControl: `max-age=${maxAge}`, contentType: 'video/frame' };
}

export class VideoPredictionCacheService {
  private readonly repository = new VideoPredictionRepository();
  private readonly pending = new Map<string, PendingWrite>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushed: Promise<void> = Promise.resolve();

  publish(identity: VideoIdentity, origin: IVideoCacheOrigin, samples: readonly IStoredVideoSample[]): void {
    if (samples.length === 0 || !isPersistentIdentity(identity)) return;
    const model = activeCacheModel();
    const key = `${identity.key}\n${model.modelId}`;
    const write = this.pending.get(key) ?? { identity, model, origin, samples: [] };
    write.samples.push(...samples);
    this.pending.set(key, write);
    if (write.samples.length >= FLUSH_ENTRY_THRESHOLD) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  async getCached(identity: VideoIdentity, reader: CachedSampleReader): Promise<ICachedVideoPredictions> {
    if (!isPersistentIdentity(identity)) return EMPTY_CACHED_VIDEO_PREDICTIONS;
    await this.flush(identity.key);
    const record = await this.repository.findValidByIdentityKey(identity.key);
    if (!record) return EMPTY_CACHED_VIDEO_PREDICTIONS;
    this.repository.touchAccessed(identity.key).catch((error: unknown) => {
      log.warn('cache.touch.failed', { ...videoIdentityAttributes(identity), error });
    });
    if (isDurationMismatch(record.durationSec, identity)) {
      await this.repository.purgeSamples(identity);
      return EMPTY_CACHED_VIDEO_PREDICTIONS;
    }
    const samplesByModel = await this.repository.readSamplesByModel(identity.key);
    const versions = Object.entries(samplesByModel).map(([modelId, samples]) => ({
      modelId,
      rank: rankOf(modelId, record.modelRanks),
      samples,
    }));
    return { samples: selectAcrossVersions(versions, reader), forcedVisibility: record.forcedVisibility };
  }

  async getForcedVisibility(identity: VideoIdentity): Promise<ForcedVisibility> {
    if (!isPersistentIdentity(identity)) return 'auto';
    const record = await this.repository.findValidByIdentityKey(identity.key);
    if (!record || isDurationMismatch(record.durationSec, identity)) return 'auto';
    return record.forcedVisibility;
  }

  async setForcedVisibility(
    identity: VideoIdentity,
    origin: IVideoCacheOrigin,
    forcedVisibility: ForcedVisibility,
  ): Promise<void> {
    if (!isPersistentIdentity(identity)) return;
    await this.flush(identity.key);
    await this.repository.updateForcedVisibility(
      identity,
      { ...origin, cacheMetadata: defaultCacheMetadata() },
      forcedVisibility,
    );
  }

  flush(identityKey?: string): Promise<void> {
    if (identityKey === undefined && this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const writes = this.takePending(identityKey);
    if (writes.length > 0) this.flushed = this.flushed.then(() => this.write(writes));
    return this.flushed;
  }

  private takePending(identityKey: string | undefined): PendingWrite[] {
    const writes: PendingWrite[] = [];
    for (const [key, write] of this.pending) {
      if (identityKey !== undefined && write.identity.key !== identityKey) continue;
      writes.push(write);
      this.pending.delete(key);
    }
    return writes;
  }

  private async write(writes: PendingWrite[]): Promise<void> {
    for (const write of writes) {
      try {
        await this.repository.mergeSamples(
          write.identity,
          write.model,
          { ...write.origin, cacheMetadata: defaultCacheMetadata() },
          write.samples,
        );
      } catch (error) {
        log.warn('cache.write.failed', { ...videoIdentityAttributes(write.identity), error });
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
