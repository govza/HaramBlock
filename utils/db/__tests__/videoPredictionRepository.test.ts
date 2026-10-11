import { describe, expect, it } from 'vitest';

import {
  bucketStartOf,
  groupByBucket,
  isVideoCacheFresh,
  mergeVideoSamples,
  VIDEO_SAMPLE_BUCKET_US,
} from '@/utils/db/videoPredictionRepository';

import type { IStoredVideoSample } from '@/utils/types';

function sample(pointUs: number, topUnsafeScore = 0.1): IStoredVideoSample {
  return {
    pointUs,
    scores: { kind: 'detections', detections: [] },
    input: { width: 640, height: 360, maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
    topUnsafeScore,
  };
}

const MINUTE_US = 60_000_000;

describe('mergeVideoSamples', () => {
  it('keys samples by exact point, sorted, letting incoming samples replace existing ones', () => {
    const merged = mergeVideoSamples([sample(2_000_000), sample(1_000_000)], [sample(2_000_000, 0.8), sample(500_000)]);
    expect(merged.map(e => e.pointUs)).toEqual([500_000, 1_000_000, 2_000_000]);
    expect(merged[2]?.topUnsafeScore).toBe(0.8);
  });

  it('keeps neighbouring points apart however close they are', () => {
    const merged = mergeVideoSamples([sample(1_000_000)], [sample(1_062_500)]);
    expect(merged.map(e => e.pointUs)).toEqual([1_000_000, 1_062_500]);
  });

  it('has no sample cap', () => {
    const existing = Array.from({ length: 5000 }, (_, i) => sample(i * 62_500));
    expect(mergeVideoSamples(existing, [sample(5000 * 62_500)])).toHaveLength(5001);
  });
});

describe('sample buckets', () => {
  it('span five minutes of media time', () => {
    expect(VIDEO_SAMPLE_BUCKET_US).toBe(5 * MINUTE_US);
    expect(bucketStartOf(0)).toBe(0);
    expect(bucketStartOf(5 * MINUTE_US - 1)).toBe(0);
    expect(bucketStartOf(5 * MINUTE_US)).toBe(5 * MINUTE_US);
    expect(bucketStartOf(61 * MINUTE_US)).toBe(60 * MINUTE_US);
  });

  it('group samples by the bucket their point falls in', () => {
    const grouped = groupByBucket([sample(6 * MINUTE_US), sample(1_000_000), sample(4 * MINUTE_US)]);
    expect([...grouped.entries()].map(([start, samples]) => [start, samples.map(s => s.pointUs)])).toEqual([
      [5 * MINUTE_US, [6 * MINUTE_US]],
      [0, [1_000_000, 4 * MINUTE_US]],
    ]);
  });
});

describe('isVideoCacheFresh', () => {
  const DAY_MS = 86_400_000;
  const record = (createdAt: number, accessedAt: number) => ({
    cacheMetadata: { createdAt, accessedAt, maxAge: DAY_MS / 1000 },
  });

  it('expires a video by its last access, not its creation', () => {
    const now = 10 * DAY_MS;
    expect(isVideoCacheFresh(record(0, now - DAY_MS / 2), now)).toBe(true);
    expect(isVideoCacheFresh(record(0, now - 2 * DAY_MS), now)).toBe(false);
  });
});
