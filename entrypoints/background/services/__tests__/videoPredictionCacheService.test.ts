import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPredictionCacheService } from '@/entrypoints/background/services/videoPredictionCacheService';

import type { IStoredVideoSample, IVideoPredictionRecord } from '@/utils/types';

const repository = vi.hoisted(() => ({
  mergeSamples: vi.fn(() => Promise.resolve()),
  updateForcedVisibility: vi.fn(() => Promise.resolve()),
  findValidByVideoUrl: vi.fn((): Promise<IVideoPredictionRecord | undefined> => Promise.resolve(undefined)),
  touchAccessed: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/utils/db/videoPredictionRepository', () => ({
  VideoPredictionRepository: vi.fn(function VideoPredictionRepository() {
    return repository;
  }),
}));

vi.mock('@inference-runtime', () => ({ getCurrentModelId: () => 'sem-i320' }));

const VIDEO_URL = 'https://example.com/video.mp4';
const ORIGIN = { sourceUrl: VIDEO_URL, hostname: 'example.com' };

function sample(pointUs: number): IStoredVideoSample {
  return {
    pointUs,
    predictions: [],
    input: { width: 320, height: 180, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
    topUnsafeScore: 0.1,
  };
}

const mergedCalls = () =>
  repository.mergeSamples.mock.calls.map(call => {
    const [videoUrl, modelId, , samples] = call as unknown as [string, string, unknown, unknown[]];
    return { videoUrl, modelId, count: samples.length };
  });

describe('VideoPredictionCacheService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never stores object-backed streams', async () => {
    const service = new VideoPredictionCacheService();
    service.publish('srcobject:abc', ORIGIN, [sample(0)]);
    await vi.runAllTimersAsync();
    expect(repository.mergeSamples).not.toHaveBeenCalled();
  });

  it('batches publishes per video and model until the flush interval elapses', async () => {
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO_URL, ORIGIN, [sample(0)]);
    service.publish(VIDEO_URL, ORIGIN, [sample(500_000)]);
    expect(repository.mergeSamples).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mergedCalls()).toEqual([{ videoUrl: VIDEO_URL, modelId: 'sem-i320', count: 2 }]);
  });

  it('flushes immediately once the entry threshold is reached', async () => {
    const service = new VideoPredictionCacheService();
    for (let i = 0; i < 50; i++) service.publish(VIDEO_URL, ORIGIN, [sample(i * 500_000)]);
    await Promise.resolve();
    expect(mergedCalls()).toEqual([{ videoUrl: VIDEO_URL, modelId: 'sem-i320', count: 50 }]);
  });

  it('flushes pending samples before persisting a forced visibility', async () => {
    const service = new VideoPredictionCacheService();
    service.publish(VIDEO_URL, ORIGIN, [sample(0)]);
    await service.setForcedVisibility(VIDEO_URL, ORIGIN, 'blocked');
    expect(repository.mergeSamples).toHaveBeenCalledBefore(repository.updateForcedVisibility);
    expect(repository.updateForcedVisibility).toHaveBeenCalledWith(
      VIDEO_URL,
      expect.objectContaining({ hostname: 'example.com' }),
      'blocked',
    );
  });

  it('returns only the active model samples', async () => {
    repository.findValidByVideoUrl.mockResolvedValueOnce({
      videoUrl: VIDEO_URL,
      sourceUrl: VIDEO_URL,
      hostname: 'example.com',
      forcedVisibility: 'auto',
      timestamp: 0,
      cacheMetadata: { createdAt: 0, accessedAt: 0 },
      samplesByModel: { 'sem-i320': [sample(0)], 'sem-i448': [sample(500_000)] },
    });
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO_URL)).resolves.toEqual({ samples: [sample(0)], forcedVisibility: 'auto' });
  });

  it('returns empty samples on a miss without touching the row', async () => {
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO_URL)).resolves.toEqual({ samples: [], forcedVisibility: 'auto' });
    expect(repository.touchAccessed).not.toHaveBeenCalled();
  });
});
