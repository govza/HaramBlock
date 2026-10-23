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
 * What a reader brings to a cache read: the playing video's aspect ratio when known, for the aspect
 * guard.
 */
export interface CachedSampleReader {
  aspectRatio: number | null;
}

export const selectCachedSamples = (
  samples: readonly IStoredVideoSample[],
  reader: CachedSampleReader,
): IStoredVideoSample[] =>
  samples.filter(sample => matchesAspectRatio(sample, reader.aspectRatio)).sort((a, b) => a.pointUs - b.pointUs);
