import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPredictionCacheService } from '@/entrypoints/background/services/videoPredictionCacheService';
import { type IStoredVideoSample, type IVideoPredictionRecord, type IPersistentVideoIdentity } from '@/utils/types';

const repository = vi.hoisted(() => ({
  mergeSamples: vi.fn(() => Promise.resolve()),
  purgeSamples: vi.fn(() => Promise.resolve()),
  updateForcedVisibility: vi.fn(() => Promise.resolve()),
  findValidByIdentityKey: vi.fn((): Promise<IVideoPredictionRecord | undefined> => Promise.resolve(undefined)),
  touchAccessed: vi.fn(() => Promise.resolve()),
  readSamplesByModel: vi.fn((): Promise<Record<string, IStoredVideoSample[]>> => Promise.resolve({})),
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
    rank: 1,
  };
  const shipped640 = { ...shipped320, id: 'sem-i640', basePath: '/models/sem-640-20260607', inputSize: 640, rank: 3 };
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
const READER = { scoreThreshold: 0.5, aspectRatio: 16 / 9 };

const unsafeDetection = {
  classId: 1,
  className: 'aurat_female',
  probability: 0.4,
  boundingBox: { x: 0, y: 0, width: 10, height: 10 },
  masks: { width: 1, height: 1, startValue: 1 as const, runs: [1] },
};

/**
 * Shape of a test sample: whether it holds a detection above the reader's strictness, and the frame
 * size it was analysed from.
 */
interface SampleShape {
  unsafe?: boolean;
  source?: { width: number; height: number };
}

function sample(pointUs: number, { unsafe = false, source }: SampleShape = {}): IStoredVideoSample {
  return {
    pointUs,
    scores: { kind: 'detections', detections: unsafe ? [{ ...unsafeDetection, probability: 0.9 }] : [] },
    input: { width: 320, height: 180, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
    topUnsafeScore: unsafe ? 0.9 : 0.1,
    ...(source ? { source } : {}),
  };
}

const points = (samples: IStoredVideoSample[]) => samples.map(entry => entry.pointUs);

const mergedCalls = () =>
  repository.mergeSamples.mock.calls.map(call => {
    const [identity, model, , samples] = call as unknown as [
      IPersistentVideoIdentity,
      { modelId: string; rank: number },
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
      { modelId: 'sem-i320@20261001', rank: 1 },
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
    sampleCounts: { 'sem-i320@20260607': 1 },
    modelRanks: { 'sem-i320@20260607': 1 },
  };

  it('reads the active model samples from their buckets', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    repository.readSamplesByModel.mockResolvedValueOnce({ [V320]: [sample(0)] });
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toEqual({
      samples: [sample(0)],
      forcedVisibility: 'blocked',
    });
    expect(repository.readSamplesByModel).toHaveBeenCalledWith(VIDEO.key);
  });

  const spaced = (fromUs: number, toUs: number, shape?: SampleShape) =>
    Array.from({ length: (toUs - fromUs) / 500_000 + 1 }, (_, index) => sample(fromUs + index * 500_000, shape));

  it('reads the best-ranked version covering a stretch instead of a lower-ranked one', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const best = spaced(0, 1_000_000, { source: { width: 1920, height: 1080 } });
    repository.readSamplesByModel.mockResolvedValueOnce({ [V320]: spaced(0, 1_000_000), [V640]: best });
    const service = new VideoPredictionCacheService();
    const { samples } = await service.getCached(VIDEO, READER);
    expect(samples).toEqual(best);
  });

  it('fills stretches the best-ranked version has not covered from lower-ranked versions, best first', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({
      ...META,
      modelRanks: { [V320]: 1, 'sem-i448@20260607': 2 },
    });
    repository.readSamplesByModel.mockResolvedValueOnce({
      [V320]: spaced(0, 4_000_000),
      'sem-i448@20260607': spaced(0, 2_000_000),
      [V640]: [...spaced(0, 1_000_000), sample(1_250_000)],
    });
    const service = new VideoPredictionCacheService();
    const { samples } = await service.getCached(VIDEO, READER);
    expect(points(samples)).toEqual([
      0, 500_000, 1_000_000, 1_250_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000, 4_000_000,
    ]);
    expect(samples.filter(entry => entry.pointUs <= 1_250_000)).toEqual([...spaced(0, 1_000_000), sample(1_250_000)]);
  });

  it('never fills between the Keyframe Points a better version analysed a long-GOP stretch at', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const keyframePoints = [sample(0), sample(2_000_000), sample(4_000_000)];
    repository.readSamplesByModel.mockResolvedValueOnce({
      [V320]: spaced(0, 6_000_000, { unsafe: true }),
      [V640]: keyframePoints,
    });
    const service = new VideoPredictionCacheService();
    const { samples } = await service.getCached(VIDEO, READER);
    expect(points(samples)).toEqual([0, 2_000_000, 4_000_000, 4_500_000, 5_000_000, 5_500_000, 6_000_000]);
  });

  it('fills a hole between two stretches a better version analysed at lattice spacing', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const before = spaced(0, 1_000_000, { source: { width: 1920, height: 1080 } });
    const after = spaced(5_000_000, 6_000_000, { source: { width: 1920, height: 1080 } });
    const lower = spaced(0, 6_000_000);
    repository.readSamplesByModel.mockResolvedValueOnce({ [V320]: lower, [V640]: [...before, ...after] });
    const service = new VideoPredictionCacheService();
    const { samples } = await service.getCached(VIDEO, READER);
    expect(samples).toEqual([...before, ...spaced(1_500_000, 4_500_000), ...after]);
  });

  it('ranks a superseded version no longer shipped by the rank stored with its samples', async () => {
    const superseded = 'sem-i640@20250101';
    repository.findValidByIdentityKey.mockResolvedValueOnce({ ...META, modelRanks: { [V320]: 1, [superseded]: 2 } });
    const old = spaced(0, 1_000_000, { source: { width: 1280, height: 720 } });
    repository.readSamplesByModel.mockResolvedValueOnce({ [V320]: spaced(0, 1_000_000), [superseded]: old });
    const service = new VideoPredictionCacheService();
    const { samples } = await service.getCached(VIDEO, READER);
    expect(samples).toEqual(old);
  });

  it('fails closed where a lower-ranked version is unsafe under the reader strictness and the selected one is clean', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const lowerUnsafe = sample(500_000, { unsafe: true });
    repository.readSamplesByModel.mockResolvedValueOnce({
      [V320]: [sample(0), lowerUnsafe, sample(1_000_000)],
      [V640]: spaced(0, 1_000_000),
    });
    const service = new VideoPredictionCacheService();
    const { samples } = await service.getCached(VIDEO, READER);
    expect(samples).toEqual([sample(0), lowerUnsafe, sample(1_000_000)]);
  });

  it('keeps the selected sample where a lower-ranked one is only unsafe under a stricter reader', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const borderline = { ...sample(0), scores: { kind: 'detections' as const, detections: [unsafeDetection] } };
    repository.readSamplesByModel.mockResolvedValueOnce({ [V320]: [borderline], [V640]: [sample(0)] });
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toMatchObject({ samples: [sample(0)] });
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    repository.readSamplesByModel.mockResolvedValueOnce({ [V320]: [borderline], [V640]: [sample(0)] });
    await expect(service.getCached(VIDEO, { ...READER, scoreThreshold: 0.3 })).resolves.toMatchObject({
      samples: [borderline],
    });
  });

  it('skips samples analysed from a rendition whose aspect ratio differs by more than 1 %', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const pillarboxed = sample(0, { source: { width: 640, height: 480 } });
    const nearlyWide = sample(500_000, { source: { width: 1918, height: 1080 } });
    const unsized = sample(1_000_000);
    repository.readSamplesByModel.mockResolvedValueOnce({ [V320]: [pillarboxed, nearlyWide, unsized] });
    const service = new VideoPredictionCacheService();
    const { samples } = await service.getCached(VIDEO, READER);
    expect(samples).toEqual([nearlyWide, unsized]);
  });

  it('lets a lower-ranked version fill a stretch whose best-ranked samples were skipped for their aspect ratio', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const lower = spaced(0, 1_000_000, { source: { width: 1280, height: 720 } });
    repository.readSamplesByModel.mockResolvedValueOnce({
      [V320]: lower,
      [V640]: spaced(0, 1_000_000, { source: { width: 1080, height: 1080 } }),
    });
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toMatchObject({ samples: lower });
  });

  it('reads samples stored for a duration within 1 s of the playing one', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({ ...META, durationSec: 60.9 });
    repository.readSamplesByModel.mockResolvedValueOnce({ [V320]: [sample(0)] });
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toMatchObject({ samples: [sample(0)] });
    expect(repository.purgeSamples).not.toHaveBeenCalled();
  });

  it('purges and skips samples and the forced visibility stored for a duration more than 1 s off', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce({ ...META, durationSec: 58.5 });
    repository.readSamplesByModel.mockResolvedValueOnce({ [V320]: [sample(0)] });
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO, READER)).resolves.toEqual({ samples: [], forcedVisibility: 'auto' });
    expect(repository.purgeSamples).toHaveBeenCalledWith(VIDEO);
  });

  it('flushes pending samples before reading, so a reopened session never re-infers them', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO, ORIGIN, [sample(0)]);
    await service.getCached(VIDEO, READER);
    expect(repository.mergeSamples).toHaveBeenCalledBefore(repository.readSamplesByModel);
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
    expect(repository.readSamplesByModel).not.toHaveBeenCalled();

    commitWrite();
    await read;

    expect(repository.readSamplesByModel).toHaveBeenCalled();
  });

  it('reads the forced visibility without loading samples', async () => {
    repository.findValidByIdentityKey.mockResolvedValueOnce(META);
    const service = new VideoPredictionCacheService();
    await expect(service.getForcedVisibility(VIDEO)).resolves.toBe('blocked');
    expect(repository.readSamplesByModel).not.toHaveBeenCalled();
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
