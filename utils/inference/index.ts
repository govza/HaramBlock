/**
 * Inference Library
 *
 * Public API:
 * - initializeInference(): Initialize the library (call once at startup)
 * - processInferenceTask(task): Process an image inference task
 *
 * Runtime is selected at build time via WXT module:
 * - Chrome: ONNX Runtime Web
 * - Firefox: TensorFlow.js
 *
 * All other implementation details are internal and not exported.
 */

// @ts-expect-error - @inference-runtime is aliased at build time by WXT module
 
import { initializeModel, processInferenceTask as runTask } from '@inference-runtime';

import type { IImagePrediction, InferenceTask } from '@/utils/types';

/**
 * Initialize the inference library.
 * Must be called once during startup before processing any inference tasks.
 *
 * This will:
 * - Set up the appropriate backend (WebGPU/WebGL/WASM)
 * - Load the AI model
 * - Warm up the model
 * - Load model metadata
 */
export async function initializeInference(): Promise<void> {
   
  await (initializeModel as () => Promise<void>)();
}

/**
 * Process an inference task for an image.
 *
 * @param task - The inference task containing image data and settings
 * @returns Promise resolving to image predictions with bounding boxes and masks
 * @throws {Error} If inference fails
 */
export function processInferenceTask(task: InferenceTask): Promise<IImagePrediction> {
   
  return (runTask as (task: InferenceTask) => Promise<IImagePrediction>)(task);
}
