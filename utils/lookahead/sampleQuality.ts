import { LEVEL0_SPACING_US } from '@/utils/lookahead/lattice';
import { isUnsafeAt } from '@/utils/lookahead/sampleScores';

import type { IFrameSize, IStoredVideoSample } from '@/utils/types';

const ASPECT_RATIO_TOLERANCE = 0.01;

/**
 * How well a sample saw its frame, compared within one model version: the long side the model
 * actually analysed, then the source pixel count.
 */
interface QualityRank {
  effectiveLongSide: number;
  sourcePixels: number;
}

type QualityInputs = Pick<IStoredVideoSample, 'input' | 'source'>;

const longSideOf = (size: IFrameSize): number => Math.max(size.width, size.height);

/**
 * The model input is the frame scaled down to fit the model, so its long side is already the smaller
 * of the source long side and the model input size; a sample without a source size ranks by it alone.
 */
function qualityRankOf({ input, source }: QualityInputs): QualityRank {
  const inputLongSide = longSideOf(input);
  if (!source) return { effectiveLongSide: inputLongSide, sourcePixels: input.width * input.height };
  return {
    effectiveLongSide: Math.min(longSideOf(source), inputLongSide),
    sourcePixels: source.width * source.height,
  };
}

export function isHigherQuality(incoming: QualityInputs, stored: QualityInputs): boolean {
  const next = qualityRankOf(incoming);
  const current = qualityRankOf(stored);
  if (next.effectiveLongSide !== current.effectiveLongSide) return next.effectiveLongSide > current.effectiveLongSide;
  return next.sourcePixels > current.sourcePixels;
}

export const aspectRatioOf = (size: IFrameSize): number | null =>
  size.width > 0 && size.height > 0 ? size.width / size.height : null;

/**
 * A sample whose source frame had another aspect ratio than the playing video would map its scores
 * onto a stretched content rect.
 */
export function matchesAspectRatio(
  sample: Pick<IStoredVideoSample, 'source'>,
  playingAspectRatio: number | null,
): boolean {
  if (!sample.source || playingAspectRatio === null) return true;
  const sourceAspectRatio = aspectRatioOf(sample.source);
  if (sourceAspectRatio === null) return false;
  return Math.abs(sourceAspectRatio / playingAspectRatio - 1) <= ASPECT_RATIO_TOLERANCE;
}

/**
 * One versioned model's cached samples of a video, with the rank that orders it against other versions.
 */
export interface RankedSamples {
  modelId: string;
  rank: number;
  samples: readonly IStoredVideoSample[];
}

/**
 * What a reader brings to a cache read: its strictness, for the fail-closed override, and the playing
 * video's aspect ratio when known, for the aspect guard.
 */
export interface CachedSampleReader {
  scoreThreshold: number;
  aspectRatio: number | null;
}

function nearestDistanceUs(sortedPoints: readonly number[], pointUs: number): number {
  let low = 0;
  let high = sortedPoints.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sortedPoints[middle] ?? 0) < pointUs) low = middle + 1;
    else high = middle;
  }
  const after = sortedPoints[low];
  const before = sortedPoints[low - 1];
  return Math.min(
    after === undefined ? Number.POSITIVE_INFINITY : after - pointUs,
    before === undefined ? Number.POSITIVE_INFINITY : pointUs - before,
  );
}

const byRankDescending = (a: RankedSamples, b: RankedSamples): number =>
  b.rank - a.rank || a.modelId.localeCompare(b.modelId);

/**
 * Picks one sample per point across model versions: the best-ranked version wherever it has samples,
 * lower-ranked ones only where no better version has a sample within a Level-0 spacing. Where a
 * lower-ranked sample at the same point is unsafe for this reader and the selected one is clean, the
 * unsafe sample wins so the cache fails closed.
 */
export function selectAcrossVersions(
  versions: readonly RankedSamples[],
  reader: CachedSampleReader,
): IStoredVideoSample[] {
  const selected = new Map<number, IStoredVideoSample>();
  const isUnsafe = (sample: IStoredVideoSample) => isUnsafeAt(sample, reader.scoreThreshold);
  for (const version of [...versions].sort(byRankDescending)) {
    const coveredPoints = [...selected.keys()].sort((a, b) => a - b);
    for (const sample of version.samples) {
      if (!matchesAspectRatio(sample, reader.aspectRatio)) continue;
      const better = selected.get(sample.pointUs);
      if (better) {
        if (isUnsafe(sample) && !isUnsafe(better)) selected.set(sample.pointUs, sample);
        continue;
      }
      if (nearestDistanceUs(coveredPoints, sample.pointUs) < LEVEL0_SPACING_US) continue;
      selected.set(sample.pointUs, sample);
    }
  }
  return [...selected.values()].sort((a, b) => a.pointUs - b.pointUs);
}
