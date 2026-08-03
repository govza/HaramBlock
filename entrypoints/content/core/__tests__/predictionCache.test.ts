import { describe, expect, it } from 'vitest';

import { PredictionCache } from '@/entrypoints/content/core/predictionCache';

import type { IImagePrediction } from '@/utils/types';

const makePrediction = (src: string): IImagePrediction => ({
  src,
  hostname: 'example.com',
  width: 100,
  height: 100,
  predictions: [],
  timestamp: 0,
  cacheMetadata: { createdAt: 0, accessedAt: 0 },
  maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  processingTime: { fetchTime: 0, decodeTime: 0, queueTime: 0, inferenceTime: 0, e2eTime: 0, backend: 'wasm' },
  forcedVisibility: 'auto',
});

describe('PredictionCache', () => {
  it('returns undefined for a miss on an empty cache', () => {
    const cache = new PredictionCache(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('stores and retrieves predictions by src', () => {
    const cache = new PredictionCache(3);
    const prediction = makePrediction('a');
    cache.set('a', prediction);
    expect(cache.get('a')).toBe(prediction);
  });

  it('does not evict when exactly at the limit', () => {
    const cache = new PredictionCache(3);
    for (const src of ['a', 'b', 'c']) cache.set(src, makePrediction(src));
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeDefined();
  });

  it('evicts the oldest entry when one over the limit', () => {
    const cache = new PredictionCache(3);
    for (const src of ['a', 'b', 'c', 'd']) cache.set(src, makePrediction(src));
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('evicts in FIFO order as more entries keep arriving', () => {
    const cache = new PredictionCache(2);
    for (const src of ['a', 'b', 'c', 'd', 'e']) cache.set(src, makePrediction(src));
    expect(cache.size).toBe(2);
    expect(cache.get('c')).toBeUndefined();
    expect(cache.get('d')).toBeDefined();
    expect(cache.get('e')).toBeDefined();
  });

  it('updates an existing src in place without evicting', () => {
    const cache = new PredictionCache(2);
    cache.set('a', makePrediction('a'));
    cache.set('b', makePrediction('b'));
    const updated = makePrediction('a');
    cache.set('a', updated);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(updated);
    expect(cache.get('b')).toBeDefined();
  });

  it('an updated entry keeps its original insertion position for eviction', () => {
    const cache = new PredictionCache(2);
    cache.set('a', makePrediction('a'));
    cache.set('b', makePrediction('b'));
    cache.set('a', makePrediction('a'));
    cache.set('c', makePrediction('c'));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('handles a cache limited to a single entry', () => {
    const cache = new PredictionCache(1);
    cache.set('a', makePrediction('a'));
    cache.set('b', makePrediction('b'));
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
  });
});
