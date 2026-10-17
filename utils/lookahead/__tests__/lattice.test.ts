import { describe, expect, it } from 'vitest';

import { latticePointsIn, probeBetween, toPointUs } from '@/utils/lookahead/lattice';

describe('Sample Lattice', () => {
  it('places level-0 Lattice Points every 0.5 s as integer µs inside a half-open range', () => {
    expect(latticePointsIn(0, 2_000_000)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
    expect(latticePointsIn(733_333, 2_000_001)).toEqual([1_000_000, 1_500_000, 2_000_000]);
  });

  it('keys a Keyframe Point by its PTS rounded up to the next µs', () => {
    expect(toPointUs(5.0000004)).toBe(5_000_001);
    expect(toPointUs(2)).toBe(2_000_000);
    expect(toPointUs(29 / 15_360)).toBe(1_889);
    expect(toPointUs(0.5)).toBe(500_000);
  });

  it('probes the midpoint of two level-0 neighbours on the next level', () => {
    expect(probeBetween(1_000_000, 1_500_000)).toBe(1_250_000);
  });

  it('stops refining at 250 ms spacing', () => {
    expect(probeBetween(1_250_000, 1_500_000)).toBeNull();
  });

  it('probes the coarsest Lattice Point nearest the midpoint between off-lattice Keyframe Points', () => {
    expect(probeBetween(5_000_001, 10_000_001)).toBe(7_500_000);
    expect(probeBetween(5_000_001, 5_400_000)).toBe(5_250_000);
  });
});
