import { LEVEL0_SPACING_US } from '@/utils/lookahead/lattice';
import { isUnsafeAt } from '@/utils/lookahead/sampleScores';

import type { IFrameSize, IStoredVideoSample } from '@/utils/types';

const ASPECT_RATIO_TOLERANCE = 0.01;
const LONGEST_COVERED_GOP_US = 10_000_000;

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

/**
 * A stretch of media time one model version analysed, from its first to its last sample.
 */
interface CoveredStretch {
  startUs: number;
  endUs: number;
}

function coveredStretchesOf(sortedPoints: readonly number[]): CoveredStretch[] {
  const stretches: CoveredStretch[] = [];
  let current: CoveredStretch | null = null;
  let gapBeforeEndUs = Number.POSITIVE_INFINITY;
  for (const pointUs of sortedPoints) {
    if (current) {
      const gapUs = pointUs - current.endUs;
      const endStandsForGop = gapBeforeEndUs > LEVEL0_SPACING_US && gapUs <= LONGEST_COVERED_GOP_US;
      if (gapUs <= LEVEL0_SPACING_US || endStandsForGop) {
        current.endUs = pointUs;
        gapBeforeEndUs = gapUs;
        continue;
      }
      stretches.push(current);
    }
    current = { startUs: pointUs, endUs: pointUs };
    gapBeforeEndUs = Number.POSITIVE_INFINITY;
  }
  if (current) stretches.push(current);
  return stretches;
}

const isWithin = (stretches: readonly CoveredStretch[], pointUs: number): boolean =>
  stretches.some(stretch => pointUs >= stretch.startUs && pointUs <= stretch.endUs);

const byRankDescending = (a: RankedSamples, b: RankedSamples): number =>
  b.rank - a.rank || a.modelId.localeCompare(b.modelId);

export function selectAcrossVersions(
  versions: readonly RankedSamples[],
  reader: CachedSampleReader,
): IStoredVideoSample[] {
  const selected = new Map<number, IStoredVideoSample>();
  const covered: CoveredStretch[] = [];
  const isUnsafe = (sample: IStoredVideoSample) => isUnsafeAt(sample, reader.scoreThreshold);
  for (const version of [...versions].sort(byRankDescending)) {
    const admitted: IStoredVideoSample[] = [];
    for (const sample of version.samples) {
      if (!matchesAspectRatio(sample, reader.aspectRatio)) continue;
      const better = selected.get(sample.pointUs);
      if (better) {
        if (isUnsafe(sample) && !isUnsafe(better)) selected.set(sample.pointUs, sample);
      } else if (!isWithin(covered, sample.pointUs)) {
        admitted.push(sample);
      }
    }
    for (const sample of admitted) selected.set(sample.pointUs, sample);
    covered.push(...coveredStretchesOf(admitted.map(sample => sample.pointUs).sort((a, b) => a - b)));
  }
  return [...selected.values()].sort((a, b) => a.pointUs - b.pointUs);
}
