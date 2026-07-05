import { describe, expect, it } from 'vitest';

import {
  computeDvrDelayMs,
  DEFAULT_DVR_DELAY_MS,
  MAX_DVR_DELAY_MS,
  MIN_DVR_DELAY_MS,
} from '@/entrypoints/content/video/dvr/delay';

describe('computeDvrDelayMs', () => {
  it('uses the default before any round-trips are observed', () => {
    expect(computeDvrDelayMs([])).toBe(DEFAULT_DVR_DELAY_MS);
  });

  it('sizes the delay above the observed round-trips', () => {
    // ~800ms round-trips: the delay must comfortably cover them.
    const delay = computeDvrDelayMs([750, 800, 820, 790, 810, 805]);
    expect(delay).toBeGreaterThan(820);
    expect(delay).toBeLessThan(MAX_DVR_DELAY_MS);
  });

  it('clamps fast sessions to the floor', () => {
    expect(computeDvrDelayMs([120, 150, 140, 130])).toBe(MIN_DVR_DELAY_MS);
  });

  it('clamps slow sessions to the ceiling', () => {
    expect(computeDvrDelayMs([5000, 6000, 5500])).toBe(MAX_DVR_DELAY_MS);
  });

  it('does not let a single outlier pin the delay at the ceiling', () => {
    const steady = Array.from({ length: 15 }, () => 600);
    const delay = computeDvrDelayMs([...steady, 9000]);
    expect(delay).toBeLessThan(MAX_DVR_DELAY_MS);
  });
});
