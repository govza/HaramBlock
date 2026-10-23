import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPredictionCacheService } from '@/entrypoints/background/services/videoPredictionCacheService';
import { type IStoredVideoSample, type IVideoPredictionRecord, type IPersistentVideoIdentity } from '@/utils/types';

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

const runtime = vi.hoisted(() => {
  const shipped320 = {
    id: 'sem-i320',
    name: '320',
    basePath: '/models/sem-320-20260607',
    inputSize: 320,
    version: '20260607',
    compatibilityKey: 'semantic:aurat_female,aurat_male',
  };
  const shipped640 = { ...shipped320, id: 'sem-i640', basePath: '/models/sem-640-20260607', inputSize: 640 };
  return { shipped320, currentModelId: 'sem-i320', models: [shipped320, shipped640] };
});

vi.mock('@inference-runtime', () => ({
  getCurrentModelId: () => runtime.currentModelId,
  getAvailableModels: () => runtime.models,
}));

const VIDEO: IPersistentVideoIdentity = { kind: 'stable', key: 'url:https://example.com/video.mp4', durationSec: 60 };
const ORIGIN = {
  sourceUrl: 'https://example.com/video.mp4?Signature=1',
  pageUrl: 'https://example.com/watch/42',
  hostname: 'example.com',
};

const V320 = 'sem-i320@20260607';
const V640 = 'sem-i640@20260607';
const SEMANTIC = 'semantic:aurat_female,aurat_male';
const READER = { aspectRatio: 16 / 9 };

function sample(pointUs: number, source?: { width: number; height: number }): IStoredVideoSample {
  return {
    pointUs,
    scores: { kind: 'detections', detections: [] },
    input: { width: 320, height: 180, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
    topUnsafeScore: 0.1,
    ...(source ? { source } : {}),
  };
}

const mergedCalls = () =>
  repository.mergeSamples.mock.calls.map(call => {
    const [identity, model, , samples] = call as unknown as [
      IPersistentVideoIdentity,
      { modelId: string },
      unknown,
      unknown[],
    ];
    return { identity, modelId: model.modelId, count: samples.length };
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

    await expect(service.getCached({ kind: 'unknown' }, READER)).resolves.toEqual({
      samples: [],
      forcedVisibility: 'auto',
    });
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
    expect(mergedCalls()).toEqual([{ identity: VIDEO, modelId: 'sem-i320@20260607', count: 2 }]);
  });

  it('files samples of new weights under an existing model id as a new cache version', async () => {
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO, ORIGIN, [sample(0)]);
    await vi.advanceTimersByTimeAsync(2000);
    runtime.models[0] = { ...runtime.shipped320, basePath: '/models/sem-320-20261001', version: '20261001' };
    service.publish(VIDEO, ORIGIN, [sample(0)]);
    await vi.advanceTimersByTimeAsync(2000);
    runtime.models[0] = runtime.shipped320;

    expect(mergedCalls().map(call => call.modelId)).toEqual(['sem-i320@20260607', 'sem-i320@20261001']);
    expect(repository.mergeSamples).toHaveBeenCalledWith(
      VIDEO,
      { modelId: 'sem-i320@20261001', compatibilityKey: SEMANTIC },
      expect.anything(),
      [sample(0)],
    );
  });

  it('records the page a video played on with its samples and its forced visibility', async () => {
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO, ORIGIN, [sample(0)]);
    await service.setForcedVisibility(VIDEO, ORIGIN, 'blocked');
    const page: unknown = expect.objectContaining({ pageUrl: 'https://example.com/watch/42' });
    expect(repository.mergeSamples).toHaveBeenCalledWith(VIDEO, expect.anything(), page, [sample(0)]);
    expect(repository.updateForcedVisibility).toHaveBeenCalledWith(VIDEO, page, 'blocked');
  });

  it('keeps videos with different identities apart', async () => {
    const other: IPersistentVideoIdentity = {
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
    expect(mergedCalls()).toEqual([{ identity: VIDEO, modelId: 'sem-i320@20260607', count: 50 }]);
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
    pageUrl: ORIGIN.pageUrl,
    hostname: 'example.com',
    forcedVisibility: 'blocked',
    timestamp: 0,
    cacheMetadata: { createdAt: 0, accessedAt: 0 },
    sampleCounts: { [V320]: 1 },
    modelCompatibility: { [V320]: SEMANTIC },
  };

  it('reads the active model version samples, sorted by point', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    repository.readSamples.mockResolvedValueOnce([sample(500_000), sample(0)]);
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toEqual({
      samples: [sample(0), sample(500_000)],
      forcedVisibility: 'blocked',
    });
    expect(repository.readSamples).toHaveBeenCalledWith(VIDEO.key, V320);
  });

  it('reads the active version even when a compatible version holds more samples', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({
      ...META,
      sampleCounts: { [V320]: 1, [V640]: 40 },
      modelCompatibility: { [V320]: SEMANTIC, [V640]: SEMANTIC },
    });
    const service = new VideoPredictionCacheService();
    await service.getCached(VIDEO, READER);
    expect(repository.readSamples).toHaveBeenCalledWith(VIDEO.key, V320);
  });

  it('falls back to the compatible version with the most samples when the active one has none', async () => {
    const superseded = 'sem-i640@20250101';
    repository.findValidByIdentityKey.mockResolvedValueOnce({
      ...META,
      sampleCounts: { [V640]: 10, [superseded]: 30 },
      modelCompatibility: { [V640]: SEMANTIC, [superseded]: SEMANTIC },
    });
    repository.readSamples.mockResolvedValueOnce([sample(0)]);
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toMatchObject({ samples: [sample(0)] });
    expect(repository.readSamples).toHaveBeenCalledWith(VIDEO.key, superseded);
  });

  it('never reads a version whose task or masked classes differ', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({
      ...META,
      sampleCounts: { 'seg-i640@20260619': 30, 'sem-i640@20261201': 30 },
      modelCompatibility: {
        'seg-i640@20260619': 'segment:aurat_female,aurat_male',
        'sem-i640@20261201': 'semantic:aurat_child,aurat_female,aurat_male',
      },
    });
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toEqual({ samples: [], forcedVisibility: 'blocked' });
    expect(repository.readSamples).not.toHaveBeenCalled();
  });

  it('skips samples analysed from a rendition whose aspect ratio differs by more than 1 %', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const pillarboxed = sample(0, { width: 640, height: 480 });
    const nearlyWide = sample(500_000, { width: 1918, height: 1080 });
    const unsized = sample(1_000_000);
    repository.readSamples.mockResolvedValueOnce([pillarboxed, nearlyWide, unsized]);
    const service = new VideoPredictionCacheService();
    const { samples } = await service.getCached(VIDEO, READER);
    expect(samples).toEqual([nearlyWide, unsized]);
  });

  it('reads samples stored for a duration within 1 s of the playing one', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({ ...META, durationSec: 60.9 });
    repository.readSamples.mockResolvedValueOnce([sample(0)]);
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toMatchObject({ samples: [sample(0)] });
    expect(repository.purgeSamples).not.toHaveBeenCalled();
  });

  it('purges and skips samples and the forced visibility stored for a duration more than 1 s off', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({ ...META, durationSec: 58.5 });
    repository.readSamples.mockResolvedValueOnce([sample(0)]);
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toEqual({ samples: [], forcedVisibility: 'auto' });
    expect(repository.purgeSamples).toHaveBeenCalledWith(VIDEO);
  });

  it('flushes pending samples before reading, so a reopened session never re-infers them', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO, ORIGIN, [sample(0)]);
    await service.getCached(VIDEO, READER);
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
    const read = service.getCached(VIDEO, READER);
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

  it('never restores a forced visibility stored for a duration more than 1 s off', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({ ...META, durationSec: 58.5 });
    const service = new VideoPredictionCacheService();
    await expect(service.getForcedVisibility(VIDEO)).resolves.toBe('auto');
  });

  it('returns empty samples on a miss without touching the row', async () => {
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toEqual({ samples: [], forcedVisibility: 'auto' });
    expect(repository.touchAccessed).not.toHaveBeenCalled();
  });
});
