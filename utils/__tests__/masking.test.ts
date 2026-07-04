import { describe, expect, it } from 'vitest';

import {
  calculateBlurPx,
  calculatePixelationBlockSize,
  buildMaskingFilter,
  buildCanvasTintFilter,
} from '@/utils/masking';

import type { IMaskingSettings } from '@/utils/types/host';

const DEFAULT_MASKING: IMaskingSettings = {
  grayscale: false,
  dark: false,
  blurIntensity: 50,
  pixelationScale: 50,
};

describe('masking utilities', () => {
  describe('calculateBlurPx', () => {
    it('should return minimum 1px at 1% intensity', () => {
      expect(calculateBlurPx(1)).toBe(1);
    });

    it('should return 15px at 50% intensity', () => {
      expect(calculateBlurPx(50)).toBe(15);
    });

    it('should return 30px at 100% intensity', () => {
      expect(calculateBlurPx(100)).toBe(30);
    });

    it('should never return 0', () => {
      for (let i = 1; i <= 100; i++) {
        expect(calculateBlurPx(i)).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('calculatePixelationBlockSize', () => {
    it('should return minimum block size at 1%', () => {
      const result = calculatePixelationBlockSize(1);
      expect(result).toBeCloseTo(8.0142, 2);
    });

    it('should return ~43.5 at 50% (quadratic curve)', () => {
      const result = calculatePixelationBlockSize(50);
      expect(result).toBeCloseTo(43.5, 1);
    });

    it('should return maximum block size at 100%', () => {
      const result = calculatePixelationBlockSize(100);
      expect(result).toBe(150);
    });

    it('should follow quadratic curve (slow start, fast end)', () => {
      const at25 = calculatePixelationBlockSize(25);
      const at75 = calculatePixelationBlockSize(75);

      // First quarter should have smaller increase than last quarter
      const firstQuarterIncrease = at25 - calculatePixelationBlockSize(1);
      const lastQuarterIncrease = calculatePixelationBlockSize(100) - at75;

      expect(lastQuarterIncrease).toBeGreaterThan(firstQuarterIncrease);
    });
  });

  describe('buildMaskingFilter', () => {
    it('should include blur by default', () => {
      const result = buildMaskingFilter(DEFAULT_MASKING);
      expect(result).toBe('blur(15px)');
    });

    it('should add grayscale when enabled', () => {
      const masking = { ...DEFAULT_MASKING, grayscale: true };
      const result = buildMaskingFilter(masking);
      expect(result).toBe('blur(15px) grayscale(100%)');
    });

    it('should add dark when enabled', () => {
      const masking = { ...DEFAULT_MASKING, dark: true };
      const result = buildMaskingFilter(masking);
      expect(result).toBe('blur(15px) brightness(0.4)');
    });

    it('should combine all filters', () => {
      const masking = { ...DEFAULT_MASKING, grayscale: true, dark: true };
      const result = buildMaskingFilter(masking);
      expect(result).toBe('blur(15px) grayscale(100%) brightness(0.4)');
    });

    it('should exclude blur when includeBlur is false', () => {
      const masking = { ...DEFAULT_MASKING, grayscale: true };
      const result = buildMaskingFilter(masking, false);
      expect(result).toBe('grayscale(100%)');
    });

    it('should return empty string when no filters active and blur excluded', () => {
      const result = buildMaskingFilter(DEFAULT_MASKING, false);
      expect(result).toBe('');
    });
  });

  describe('buildCanvasTintFilter', () => {
    it('should exclude blur', () => {
      const result = buildCanvasTintFilter(DEFAULT_MASKING);
      expect(result).toBe('');
    });

    it('should include grayscale and dark', () => {
      const masking = { ...DEFAULT_MASKING, grayscale: true, dark: true };
      const result = buildCanvasTintFilter(masking);
      expect(result).toBe('grayscale(100%) brightness(0.4)');
    });
  });
});
