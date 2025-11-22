/**
 * Inference Library
 *
 * Public API:
 * - initializeInference(): Initialize the library (call once at startup)
 * - processInferenceTask(task): Process an image inference task
 *
 * All other implementation details are internal and not exported.
 */

import { initializeModel } from '@/utils/inference/modelLoader';
import * as prediction from '@/utils/inference/prediction';

import type { IImagePrediction, InferenceTask } from '@/utils/types';

/**
 * Initialize the inference library.
 * Must be called once during startup before processing any inference tasks.
 *
 * This will:
 * - Set up TensorFlow backend (WebGPU/WebGL)
 * - Load the AI model
 * - Warm up the model
 * - Load model metadata
 */
export async function initializeInference(): Promise<void> {
  await initializeModel();
}

/**
 * Process an inference task for an image.
 *
 * @param task - The inference task containing image data and settings
 * @returns Promise resolving to image predictions with bounding boxes and masks
 * @throws {Error} If inference fails
 */
export async function processInferenceTask(task: InferenceTask): Promise<IImagePrediction> {
  return prediction.processInferenceTask(task);
}
