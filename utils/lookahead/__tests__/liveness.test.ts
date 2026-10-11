import { describe, expect, it } from 'vitest';

import { combinedLiveness, livenessOfDuration } from '@/utils/lookahead/ports';

describe('livenessOfDuration', () => {
  it('reads an infinite duration as live', () => {
    expect(livenessOfDuration(Number.POSITIVE_INFINITY)).toBe('live');
  });

  it('reads a finite duration as vod', () => {
    expect(livenessOfDuration(212.4)).toBe('vod');
  });

  it('leaves a duration the player has not set yet unknown', () => {
    expect(livenessOfDuration(Number.NaN)).toBe('unknown');
    expect(livenessOfDuration(0)).toBe('unknown');
  });
});

describe('combinedLiveness', () => {
  it('is live when any reading is live', () => {
    expect(combinedLiveness('vod', 'unknown', 'live')).toBe('live');
  });

  it('is vod only once every reading is vod', () => {
    expect(combinedLiveness('vod', 'unknown')).toBe('unknown');
    expect(combinedLiveness('vod', 'vod')).toBe('vod');
  });
});
