import type { IElementPrediction, IScoreGrid, IModelMetadata } from '@/utils/types';

/** Raw ONNX Runtime output tensors, narrowed to the numeric shape postprocessors consume. */
export type TypedResults = Record<string, { data: ArrayLike<number>; dims: readonly number[] }>;

/** Everything a postprocessor needs to turn model outputs into predictions. */
export interface PostprocessContext {
  results: TypedResults;
  config: IModelMetadata;
  scoreThreshold: number;
  originalWidth: number;
  originalHeight: number;
  includeScoreGrid?: boolean;
}

/**
 * Output of a Postprocessor: the predictions above threshold, the top unsafe score and, when
 * requested, the raw score grid.
 */
export interface PostprocessResult {
  predictions: IElementPrediction[];
  topUnsafeScore: number;
  scoreGrid?: IScoreGrid;
}

/** Converts raw model outputs into predictions. One implementation per model task. */
export type Postprocessor = (ctx: PostprocessContext) => PostprocessResult;
