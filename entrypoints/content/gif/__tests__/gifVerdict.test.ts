import { describe, expect, it } from 'vitest';

import { aggregateGifVerdict, type GifVerdictInput } from '@/entrypoints/content/gif/gifVerdict';
import { shouldBlock, type IElementPrediction, type IGifFramePrediction } from '@/utils/types';

const SRC = 'https://cdn.test/a.gif';

const frame = (frameIndex: number, detections: number, size = 100): IGifFramePrediction => ({
  sessionId: 's',
  hostname: 'example.com',
  src: SRC,
  frameIndex,
  frameCount: 3,
  width: size,
  height: size,
  predictions: Array.from({ length: detections }, () => ({}) as IElementPrediction),
  maskTransform: { scaleX: frameIndex + 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  timestamp: 0,
});

const input = (overrides: Partial<GifVerdictInput>): GifVerdictInput => ({
  src: SRC,
  hostname: 'example.com',
  framePredictions: [],
  forceBlocked: false,
  now: 42,
  ...overrides,
});

describe('aggregateGifVerdict', () => {
  it('reports the busiest frame instead of summing detections', () => {
    const verdict = aggregateGifVerdict(input({ framePredictions: [frame(0, 1), frame(1, 3), frame(2, 2)] }));
    expect(verdict.predictions).toHaveLength(3);
    expect(shouldBlock(verdict)).toBe(true);
  });

  it('takes size and mask transform from the earliest frame regardless of arrival order', () => {
    const verdict = aggregateGifVerdict(input({ framePredictions: [frame(2, 0, 300), frame(1, 0, 200)] }));
    expect(verdict.width).toBe(200);
    expect(verdict.maskTransform.scaleX).toBe(2);
  });

  it('is safe and auto when no frame had a detection', () => {
    const verdict = aggregateGifVerdict(input({ framePredictions: [frame(0, 0), frame(1, 0)] }));
    expect(verdict.predictions).toEqual([]);
    expect(verdict.forcedVisibility).toBe('auto');
    expect(shouldBlock(verdict)).toBe(false);
  });

  it('fails closed when forced, even without detections', () => {
    const verdict = aggregateGifVerdict(input({ framePredictions: [frame(0, 0)], forceBlocked: true }));
    expect(verdict.forcedVisibility).toBe('blocked');
    expect(shouldBlock(verdict)).toBe(true);
  });

  it('sizes a verdict without frame predictions from the fallback, else zero', () => {
    const sized = aggregateGifVerdict(input({ fallbackSize: { width: 64, height: 48 }, forceBlocked: true }));
    expect([sized.width, sized.height]).toEqual([64, 48]);
    expect(sized.maskTransform).toEqual({ scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 });

    const unsized = aggregateGifVerdict(input({}));
    expect([unsized.width, unsized.height]).toEqual([0, 0]);
  });

  it('stamps every timestamp with the given time', () => {
    const verdict = aggregateGifVerdict(input({}));
    expect(verdict.timestamp).toBe(42);
    expect(verdict.cacheMetadata).toEqual({ contentType: 'image/gif', createdAt: 42, accessedAt: 42 });
  });
});
