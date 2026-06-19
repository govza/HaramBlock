/**
 * Inference Library
 *
 * Public API:
 * - initializeInference(): Initialize the library (call once at startup)
 * - processInferenceTask(task): Process a single image inference task
 * - processInferenceBatch(tasks): Process several tasks as one batched session.run
 * - getBatchCap(): Max images per batch for the active model (1 = no batching)
 * - getInferenceBackend(): Get the current backend (webgpu/wasm)
 *
 * Runtime: ONNX Runtime Web (WebGPU with WASM fallback)
 *
 * All other implementation details are internal and not exported.
 */

import {
  getActiveModelConfig,
  getBackend,
  initializeModel,
  processInferenceBatch as runInferenceBatch,
  processInferenceTask as runInferenceTask,
} from '@inference-runtime';

import { computeBatchCap } from '@/utils/inference/shared/modelRegistry';

import type { InferenceTask } from '@/utils/types';

export async function initializeInference(modelId?: string): Promise<void> {
  await initializeModel(modelId);
}

export function processInferenceTask(task: InferenceTask) {
  return runInferenceTask(task);
}

export function processInferenceBatch(tasks: InferenceTask[]) {
  return runInferenceBatch(tasks);
}

export function getBatchCap(): number {
  return computeBatchCap(getActiveModelConfig());
}

export function getInferenceBackend() {
  return getBackend();
}
