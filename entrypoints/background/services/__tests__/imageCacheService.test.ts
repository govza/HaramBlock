import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import { type IImagePrediction } from '@/utils/types';

const repository = vi.hoisted(() => ({
  storeOwn: vi.fn(() => Promise.resolve()),
  setForcedVisibility: vi.fn(() => Promise.resolve()),
  touch: vi.fn(() => Promise.resolve()),
  rehome: vi.fn(() => Promise.resolve()),
  findValidByHostname: vi.fn((): Promise<IImagePrediction[]> => Promise.resolve([])),
}));

vi.mock('@/utils/db/imagePredictionRepository', () => ({
  ImagePredictionRepository: vi.fn(function ImagePredictionRepository() {
    return repository;
  }),
}));

const SRC = 'https://cdn.example.com/a.jpg';
const NOW = 1_800_000_000_000;

const STORED: IImagePrediction = {
  src: SRC,
  hostname: 'example.com',
  width: 100,
  height: 100,
  predictions: [],
  timestamp: 5,
  cacheMetadata: { createdAt: 5, accessedAt: 5, maxAge: 2_592_000 },
  maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  processingTime: { fetchTime: 0, decodeTime: 0, queueTime: 0, inferenceTime: 0, e2eTime: 0, backend: 'wasm' },
  forcedVisibility: 'auto',
};

describe('ImageCacheService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores an own prediction exactly as inferred', async () => {
    await new ImageCacheService().storeOwn(STORED);
    expect(repository.storeOwn).toHaveBeenCalledWith(STORED);
  });

  it('persists the forced visibility of an image by its src', async () => {
    await new ImageCacheService().setForcedVisibility(SRC, 'visible');
    expect(repository.setForcedVisibility).toHaveBeenCalledWith(SRC, 'visible');
  });

  it('rehomes a prediction under the reading hostname and refreshes its access time', () => {
    const rehomed = new ImageCacheService().rehome(STORED, 'other.example');
    expect(rehomed).toEqual({
      ...STORED,
      hostname: 'other.example',
      cacheMetadata: { ...STORED.cacheMetadata, accessedAt: NOW },
    });
    expect(repository.rehome).toHaveBeenCalledWith(SRC, 'other.example', NOW);
  });

  it('touches the access time of every prediction read for a hostname, returning them as stored', async () => {
    repository.findValidByHostname.mockResolvedValueOnce([STORED]);
    await expect(new ImageCacheService().getCachedPredictionsByHostname('example.com')).resolves.toEqual([STORED]);
    expect(repository.touch).toHaveBeenCalledWith(SRC, NOW);
  });

  it('answers a rehome even when its write fails', () => {
    repository.rehome.mockRejectedValueOnce(new Error('quota'));
    expect(new ImageCacheService().rehome(STORED, 'other.example').hostname).toBe('other.example');
  });
});
