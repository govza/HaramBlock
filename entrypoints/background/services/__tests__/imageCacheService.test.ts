import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import { type IImagePrediction } from '@/utils/types';

const repository = vi.hoisted(() => ({
  storeOwn: vi.fn(() => Promise.resolve()),
  setForcedVisibility: vi.fn(() => Promise.resolve(false)),
  touch: vi.fn(() => Promise.resolve()),
  rehome: vi.fn(() => Promise.resolve()),
  findValidByHostname: vi.fn((): Promise<IImagePrediction[]> => Promise.resolve([])),
}));

vi.mock('@/utils/db/imagePredictionRepository', () => ({
  ImagePredictionRepository: vi.fn(function ImagePredictionRepository() {
    return repository;
  }),
}));

vi.mock('@inference-runtime', () => ({
  getAvailableModels: () => [{ id: 'sem-i320', version: '20260607' }],
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
  modelId: 'sem-i320',
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

  it('stores an eligible own prediction as inferred, waiting to be reported', async () => {
    const onReportPending = vi.fn();
    const service = new ImageCacheService();
    service.setOnReportPending(onReportPending);
    await service.storeOwn(STORED);
    expect(repository.storeOwn).toHaveBeenCalledWith({
      ...STORED,
      provenance: 'own',
      reportStatus: 'pending',
      reportChangedAt: NOW,
      reportHostname: 'example.com',
    });
    expect(onReportPending).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an image on the local network', { src: 'http://192.168.1.20/cam.jpg' }],
    ['an image shown on a page of the local network', { hostname: 'nas.local' }],
    ['an image the site marked private', { cacheMetadata: { ...STORED.cacheMetadata, cacheControl: 'private' } }],
    ['a GIF', { cacheMetadata: { ...STORED.cacheMetadata, contentType: 'image/gif' } }],
    ['a prediction of an unknown model', { modelId: 'unknown' }],
  ])('stores %s as own with no Report Status', async (_rule, overrides) => {
    const onReportPending = vi.fn();
    const service = new ImageCacheService();
    service.setOnReportPending(onReportPending);
    await service.storeOwn({ ...STORED, ...overrides });
    expect(repository.storeOwn).toHaveBeenCalledWith({ ...STORED, ...overrides, provenance: 'own' });
    expect(onReportPending).not.toHaveBeenCalled();
  });

  it('persists the forced visibility of an image by its src', async () => {
    await new ImageCacheService().setForcedVisibility(SRC, 'visible');
    expect(repository.setForcedVisibility).toHaveBeenCalledWith(SRC, 'visible', NOW);
  });

  it('announces a pending report only when a toggle made the row pending', async () => {
    const onReportPending = vi.fn();
    const service = new ImageCacheService();
    service.setOnReportPending(onReportPending);
    await service.setForcedVisibility(SRC, 'visible');
    expect(onReportPending).not.toHaveBeenCalled();
    repository.setForcedVisibility.mockResolvedValueOnce(true);
    await service.setForcedVisibility(SRC, 'auto');
    expect(onReportPending).toHaveBeenCalledTimes(1);
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
