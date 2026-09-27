import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPredictionCacheService } from '@/entrypoints/background/services/videoPredictionCacheService';

import type { IFramePrediction } from '@/utils/types';

const repository = vi.hoisted(() => ({
  mergeSamples: vi.fn(() => Promise.resolve()),
  updateForcedVisibility: vi.fn(() => Promise.resolve()),
  findValidByVideoUrl: vi.fn(() => Promise.resolve(undefined)),
  touchAccessed: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/utils/db/videoPredictionRepository', () => ({
  VideoPredictionRepository: vi.fn(function VideoPredictionRepository() {
    return repository;
  }),
}));

vi.mock('@inference-runtime', () => ({ getCurrentModelId: () => 'sem-i320' }));

const VIDEO_URL = 'https://example.com/video.mp4';

function framePrediction(overrides: Partial<IFramePrediction> = {}): IFramePrediction {
  return {
    sessionId: 'session',
    frameIndex: 1,
    timestampSec: 1,
    videoUrl: VIDEO_URL,
    sourceUrl: VIDEO_URL,
    src: '',
    hostname: 'example.com',
    width: 320,
    height: 180,
    predictions: [],
    maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    timestamp: 0,
    cacheMetadata: { createdAt: 0, accessedAt: 0 },
    processingTime: { fetchTime: 0, decodeTime: 0, queueTime: 0, inferenceTime: 0, e2eTime: 0, backend: 'webgpu' },
    ...overrides,
  };
}

const mergedEntryCounts = () =>
  repository.mergeSamples.mock.calls.map(call => (call as unknown as [string, unknown, unknown[]])[2].length);

describe('VideoPredictionCacheService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips thumbnails and object-backed streams', async () => {
    const service = new VideoPredictionCacheService();
    service.record(framePrediction({ frameIndex: -1 }));
    service.record(framePrediction({ videoUrl: 'srcobject:abc' }));
    await vi.runAllTimersAsync();
    expect(repository.mergeSamples).not.toHaveBeenCalled();
  });

  it('batches writes until the flush interval elapses', async () => {
    const service = new VideoPredictionCacheService();
    service.record(framePrediction({ timestampSec: 1 }));
    service.record(framePrediction({ timestampSec: 1.25 }));
    expect(repository.mergeSamples).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mergedEntryCounts()).toEqual([2]);
  });

  it('flushes immediately once the entry threshold is reached', async () => {
    const service = new VideoPredictionCacheService();
    for (let i = 0; i < 50; i++) service.record(framePrediction({ timestampSec: i * 0.25 }));
    await Promise.resolve();
    expect(mergedEntryCounts()).toEqual([50]);
  });

  it('flushes pending verdicts before persisting a forced visibility', async () => {
    const service = new VideoPredictionCacheService();
    service.record(framePrediction());
    await service.setForcedVisibility(VIDEO_URL, { sourceUrl: VIDEO_URL, hostname: 'example.com' }, 'blocked');
    expect(repository.mergeSamples).toHaveBeenCalledBefore(repository.updateForcedVisibility);
    expect(repository.updateForcedVisibility).toHaveBeenCalledWith(
      VIDEO_URL,
      expect.objectContaining({ modelId: 'sem-i320', hostname: 'example.com' }),
      'blocked',
    );
  });

  it('returns empty verdicts on a miss without touching the row', async () => {
    const service = new VideoPredictionCacheService();
    await expect(service.getCached(VIDEO_URL)).resolves.toEqual({ samples: [], forcedVisibility: 'auto' });
    expect(repository.touchAccessed).not.toHaveBeenCalled();
  });
});
