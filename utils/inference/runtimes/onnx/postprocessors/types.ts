import type { IElementPrediction, ModelMetadata } from '@/utils/types';

/** Raw ONNX Runtime output tensors, narrowed to the numeric shape postprocessors consume. */
export type TypedResults = Record<string, { data: ArrayLike<number>; dims: readonly number[] }>;

/** Everything a postprocessor needs to turn model outputs into predictions. */
export interface PostprocessContext {
  results: TypedResults;
  config: ModelMetadata;
  scoreThreshold: number;
  originalWidth: number;
  originalHeight: number;
}

/** Converts raw model outputs into predictions. One implementation per model task. */
export type Postprocessor = (ctx: PostprocessContext) => IElementPrediction[];
