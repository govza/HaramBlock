/**
 * Inference Library
 *
 * Public API:
 * - initializeInference(): Initialize the library (call once at startup)
 * - processInferenceTask(task): Process an image inference task
 * - getInferenceBackend(): Get the current backend (webgpu/wasm)
 *
 * Runtime: ONNX Runtime Web (WebGPU with WASM fallback)
 *
 * All other implementation details are internal and not exported.
 */

import { getBackend, initializeModel, processInferenceTask as runInferenceTask } from '@inference-runtime';

import type { InferenceTask } from '@/utils/types';

export async function initializeInference(modelId?: string): Promise<void> {
  await initializeModel(modelId);
}

export function processInferenceTask(task: InferenceTask) {
  return runInferenceTask(task);
}

export function getInferenceBackend() {
  return getBackend();
}
