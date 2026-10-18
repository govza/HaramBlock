import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPredictionCacheService } from '@/entrypoints/background/services/videoPredictionCacheService';

import type { IStoredVideoSample, IVideoPredictionRecord } from '@/utils/types';
import type { PersistentVideoIdentity } from '@/utils/videoIdentity';

const repository = vi.hoisted(() => ({
  mergeSamples: vi.fn(() => Promise.resolve()),
  purgeSamples: vi.fn(() => Promise.resolve()),
  updateForcedVisibility: vi.fn(() => Promise.resolve()),
  findValidByIdentityKey: vi.fn((): Promise<IVideoPredictionRecord | undefined> => Promise.resolve(undefined)),
  touchAccessed: vi.fn(() => Promise.resolve()),
  readSamples: vi.fn((): Promise<IStoredVideoSample[]> => Promise.resolve([])),
}));

vi.mock('@/utils/db/videoPredictionRepository', () => ({
  VideoPredictionRepository: vi.fn(function VideoPredictionRepository() {
    return repository;
  }),
}));

vi.mock('@inference-runtime', () => ({ getCurrentModelId: () => 'sem-i320' }));

const VIDEO: PersistentVideoIdentity = { kind: 'stable', key: 'url:https://example.com/video.mp4', durationSec: 60 };
const ORIGIN = { sourceUrl: 'https://example.com/video.mp4?Signature=1', hostname: 'example.com' };

function sample(pointUs: number): IStoredVideoSample {
  return {
    pointUs,
    scores: { kind: 'detections', detections: [] },
    input: { width: 320, height: 180, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
    topUnsafeScore: 0.1,
  };
}

const mergedCalls = () =>
  repository.mergeSamples.mock.calls.map(call => {
    const [identity, modelId, , samples] = call as unknown as [PersistentVideoIdentity, string, unknown, unknown[]];
    return { identity, modelId, count: samples.length };
  });

describe('VideoPredictionCacheService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never reads or writes media whose identity is unknown', async () => {
    const service = new VideoPredictionCacheService();
    service.publish({ kind: 'unknown' }, ORIGIN, [sample(0)]);
    await service.setForcedVisibility({ kind: 'unknown' }, ORIGIN, 'blocked');
    await vi.runAllTimersAsync();

    await expect(service.getCached({ kind: 'unknown' })).resolves.toEqual({ samples: [], forcedVisibility: 'auto' });
    await expect(service.getForcedVisibility({ kind: 'unknown' })).resolves.toBe('auto');
    expect(repository.mergeSamples).not.toHaveBeenCalled();
    expect(repository.updateForcedVisibility).not.toHaveBeenCalled();
    expect(repository.findValidByIdentityKey).not.toHaveBeenCalled();
  });

  it('batches publishes per identity and model until the flush interval elapses', async () => {
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO, ORIGIN, [sample(0)]);
    service.publish(VIDEO, ORIGIN, [sample(500_000)]);
    expect(repository.mergeSamples).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mergedCalls()).toEqual([{ identity: VIDEO, modelId: 'sem-i320', count: 2 }]);
  });

  it('keeps videos with different identities apart', async () => {
    const other: PersistentVideoIdentity = {
      kind: 'local',
      key: 'page:https://example.com/feed|d=450',
      durationSec: 45,
    };
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO, ORIGIN, [sample(0)]);
    service.publish(other, ORIGIN, [sample(0)]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mergedCalls().map(call => call.identity.key)).toEqual([VIDEO.key, other.key]);
  });

  it('flushes immediately once the entry threshold is reached', async () => {
    const service = new VideoPredictionCacheService();
    for (let i = 0; i < 50; i++) service.publish(VIDEO, ORIGIN, [sample(i * 500_000)]);
    await Promise.resolve();
    expect(mergedCalls()).toEqual([{ identity: VIDEO, modelId: 'sem-i320', count: 50 }]);
  });

  it('flushes pending samples before persisting a forced visibility', async () => {
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO, ORIGIN, [sample(0)]);
    await service.setForcedVisibility(VIDEO, ORIGIN, 'blocked');
    expect(repository.mergeSamples).toHaveBeenCalledBefore(repository.updateForcedVisibility);
    expect(repository.updateForcedVisibility).toHaveBeenCalledWith(
      VIDEO,
      expect.objectContaining({ hostname: 'example.com' }),
      'blocked',
    );
  });

  const META: IVideoPredictionRecord = {
    identityKey: VIDEO.key,
    identityKind: 'stable',
    durationSec: 60,
    sourceUrl: ORIGIN.sourceUrl,
    hostname: 'example.com',
    forcedVisibility: 'blocked',
    timestamp: 0,
    cacheMetadata: { createdAt: 0, accessedAt: 0 },
    sampleCounts: { 'sem-i320': 1 },
  };

  it('reads the active model samples from their buckets', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    repository.readSamples.mockResolvedValueOnce([sample(0)]);
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO)).resolves.toEqual({ samples: [sample(0)], forcedVisibility: 'blocked' });
    expect(repository.readSamples).toHaveBeenCalledWith(VIDEO.key, 'sem-i320');
  });

  it('reads samples stored for a duration within 1 s of the playing one', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({ ...META, durationSec: 60.9 });
    repository.readSamples.mockResolvedValueOnce([sample(0)]);
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO)).resolves.toMatchObject({ samples: [sample(0)] });
    expect(repository.purgeSamples).not.toHaveBeenCalled();
  });

  it('purges and skips samples stored for a duration more than 1 s off', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({ ...META, durationSec: 58.5 });
    repository.readSamples.mockResolvedValueOnce([sample(0)]);
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO)).resolves.toEqual({ samples: [], forcedVisibility: 'blocked' });
    expect(repository.purgeSamples).toHaveBeenCalledWith(VIDEO);
  });

  it('flushes pending samples before reading, so a reopened session never re-infers them', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO, ORIGIN, [sample(0)]);
    await service.getCached(VIDEO);
    expect(repository.mergeSamples).toHaveBeenCalledBefore(repository.readSamples);
  });

  it('reads only after a flush already writing has committed its samples', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    let commitWrite = () => {};
    repository.mergeSamples.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          commitWrite = resolve;
        }),
    );
    const service = new VideoPredictionCacheService();
    service.publish(
      VIDEO,
      ORIGIN,
      Array.from({ length: 50 }, (_, index) => sample(index)),
    );
    const read = service.getCached(VIDEO);
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.readSamples).not.toHaveBeenCalled();

    commitWrite();
    await read;

    expect(repository.readSamples).toHaveBeenCalled();
  });

  it('reads the forced visibility without loading samples', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const service = new VideoPredictionCacheService();
    await expect(service.getForcedVisibility(VIDEO)).resolves.toBe('blocked');
    expect(repository.readSamples).not.toHaveBeenCalled();
  });

  it('returns empty samples on a miss without touching the row', async () => {
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO)).resolves.toEqual({ samples: [], forcedVisibility: 'auto' });
    expect(repository.touchAccessed).not.toHaveBeenCalled();
  });
});
