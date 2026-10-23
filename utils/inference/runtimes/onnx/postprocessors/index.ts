import { processInstanceSegmentation } from '@/utils/inference/runtimes/onnx/postprocessors/instance';
import { processSemanticSegmentation } from '@/utils/inference/runtimes/onnx/postprocessors/semantic';

import type { Postprocessor } from '@/utils/inference/runtimes/onnx/postprocessors/types';
import type { IModelMetadata } from '@/utils/types';

// Exhaustive over the task union: adding a task to IModelMetadata['task'] forces a handler here.
const POSTPROCESSORS: Record<IModelMetadata['task'], Postprocessor> = {
  semantic: processSemanticSegmentation,
  segment: processInstanceSegmentation,
};

export function getPostprocessor(task: IModelMetadata['task']): Postprocessor {
  return POSTPROCESSORS[task];
}

export type {
  PostprocessContext,
  PostprocessResult,
  Postprocessor,
  TypedResults,
} from '@/utils/inference/runtimes/onnx/postprocessors/types';
