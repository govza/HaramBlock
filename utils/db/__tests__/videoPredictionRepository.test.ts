import { describe, expect, it } from 'vitest';

import { mergeVideoSamples } from '@/utils/db/videoPredictionRepository';

import type { IStoredVideoSample } from '@/utils/types';

function sample(pointUs: number, unsafe = false): IStoredVideoSample {
  return {
    pointUs,
    predictions: unsafe ? [{} as IStoredVideoSample['predictions'][number]] : [],
    input: { width: 640, height: 360, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
    topUnsafeScore: unsafe ? 0.8 : 0.1,
  };
}

describe('mergeVideoSamples', () => {
  it('keys samples by exact point, sorted, letting incoming samples replace existing ones', () => {
    const merged = mergeVideoSamples(
      [sample(2_000_000), sample(1_000_000)],
      [sample(2_000_000, true), sample(500_000)],
    );
    expect(merged.map(e => e.pointUs)).toEqual([500_000, 1_000_000, 2_000_000]);
    expect(merged[2]?.predictions).toHaveLength(1);
  });

  it('keeps neighbouring points apart however close they are', () => {
    const merged = mergeVideoSamples([sample(1_000_000)], [sample(1_062_500)]);
    expect(merged.map(e => e.pointUs)).toEqual([1_000_000, 1_062_500]);
  });

  it('drops the earliest points past the cap', () => {
    const merged = mergeVideoSamples([sample(1), sample(2), sample(3)], [sample(4)], 2);
    expect(merged.map(e => e.pointUs)).toEqual([3, 4]);
  });
});
