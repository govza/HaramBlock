import { describe, expect, it } from 'vitest';

import { isValidPrediction } from '@/utils/db/predictionValidity';

import type { IImagePrediction } from '@/utils/types';

const NOW = 1_700_000_000_000;

const makePrediction = (cacheMetadata: Partial<IImagePrediction['cacheMetadata']>): IImagePrediction => ({
  src: 'https://example.com/img.jpg',
  hostname: 'example.com',
  width: 100,
  height: 100,
  predictions: [],
  timestamp: NOW,
  cacheMetadata: { createdAt: NOW, accessedAt: NOW, ...cacheMetadata },
  maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  processingTime: { fetchTime: 0, decodeTime: 0, queueTime: 0, inferenceTime: 0, e2eTime: 0, backend: 'wasm' },
  forcedVisibility: 'auto',
});

describe('isValidPrediction', () => {
  it('is valid when no expiry rules are set', () => {
    expect(isValidPrediction(makePrediction({}), NOW)).toBe(true);
  });

  describe('expires header', () => {
    it('is valid before the expires timestamp', () => {
      expect(isValidPrediction(makePrediction({ expires: NOW + 1000 }), NOW)).toBe(true);
    });

    it('is valid exactly at the expires timestamp', () => {
      expect(isValidPrediction(makePrediction({ expires: NOW }), NOW)).toBe(true);
    });

    it('is expired one millisecond past the expires timestamp', () => {
      expect(isValidPrediction(makePrediction({ expires: NOW - 1 }), NOW)).toBe(false);
    });
  });

  describe('max-age', () => {
    it('is valid while younger than maxAge', () => {
      const prediction = makePrediction({ maxAge: 60, createdAt: NOW - 30_000 });
      expect(isValidPrediction(prediction, NOW)).toBe(true);
    });

    it('is valid exactly at the maxAge boundary', () => {
      const prediction = makePrediction({ maxAge: 60, createdAt: NOW - 60_000 });
      expect(isValidPrediction(prediction, NOW)).toBe(true);
    });

    it('is expired once older than maxAge', () => {
      const prediction = makePrediction({ maxAge: 60, createdAt: NOW - 60_001 });
      expect(isValidPrediction(prediction, NOW)).toBe(false);
    });

    it('a zero maxAge does not expire the entry (falsy rule is ignored)', () => {
      const prediction = makePrediction({ maxAge: 0, createdAt: NOW - 60_000 });
      expect(isValidPrediction(prediction, NOW)).toBe(true);
    });
  });

  describe('combined rules', () => {
    it('is expired when expires passed even if maxAge is still fresh', () => {
      const prediction = makePrediction({ expires: NOW - 1, maxAge: 3600, createdAt: NOW - 1000 });
      expect(isValidPrediction(prediction, NOW)).toBe(false);
    });

    it('is expired when maxAge passed even if expires is in the future', () => {
      const prediction = makePrediction({ expires: NOW + 100_000, maxAge: 60, createdAt: NOW - 120_000 });
      expect(isValidPrediction(prediction, NOW)).toBe(false);
    });

    it('is valid when both rules are still fresh', () => {
      const prediction = makePrediction({ expires: NOW + 100_000, maxAge: 60, createdAt: NOW - 1000 });
      expect(isValidPrediction(prediction, NOW)).toBe(true);
    });
  });
});
