import { processInstanceSegmentation } from '@/utils/inference/runtimes/onnx/postprocessors/instance';
import { processSemanticSegmentation } from '@/utils/inference/runtimes/onnx/postprocessors/semantic';

import type { Postprocessor } from '@/utils/inference/runtimes/onnx/postprocessors/types';
import type { ModelMetadata } from '@/utils/types';

// Exhaustive over the task union: adding a task to ModelMetadata['task'] forces a handler here.
const POSTPROCESSORS: Record<ModelMetadata['task'], Postprocessor> = {
  semantic: processSemanticSegmentation,
  segment: processInstanceSegmentation,
};

export function getPostprocessor(task: ModelMetadata['task']): Postprocessor {
  return POSTPROCESSORS[task];
}

export type {
  PostprocessContext,
  Postprocessor,
  TypedResults,
} from '@/utils/inference/runtimes/onnx/postprocessors/types';
