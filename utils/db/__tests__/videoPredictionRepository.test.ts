import { describe, expect, it } from 'vitest';

import { mergeFrameSamples } from '@/utils/db/videoPredictionRepository';

import type { ICachedFrameSample } from '@/utils/types';

function sample(timestampSec: number, unsafe = false): ICachedFrameSample {
  return {
    timestampSec,
    predictions: unsafe ? [{} as ICachedFrameSample['predictions'][number]] : [],
    input: { width: 640, height: 360, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
  };
}

describe('mergeFrameSamples', () => {
  it('sorts by timestamp and lets incoming samples replace existing ones', () => {
    const merged = mergeFrameSamples([sample(2), sample(1)], [sample(2, true), sample(0.5)]);
    expect(merged.map(e => e.timestampSec)).toEqual([0.5, 1, 2]);
    expect(merged[2]?.predictions).toHaveLength(1);
  });

  it('drops the oldest timestamps past the cap', () => {
    const merged = mergeFrameSamples([sample(1), sample(2), sample(3)], [sample(4)], 2);
    expect(merged.map(e => e.timestampSec)).toEqual([3, 4]);
  });
});
