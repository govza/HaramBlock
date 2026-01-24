/**
 * Type declarations for @inference-runtime alias.
 * The actual implementation is selected at build time by the WXT module:
 * - Chrome: utils/inference/runtimes/onnx
 * - Firefox: utils/inference/runtimes/tfjs
 */

import type { IImagePrediction, InferenceTask } from '@/utils/types';

declare module '@inference-runtime' {
  export interface ModelDefinition {
    id: string;
    name: string;
    basePath: string;
    inputSize: number;
  }

  export function initializeModel(modelId?: string): Promise<void>;
  export function processInferenceTask(task: InferenceTask): Promise<IImagePrediction>;
  export function switchModel(modelId: string): Promise<void>;
  export function getCurrentModelId(): string | null;
  export function getAvailableModels(): ModelDefinition[];
  export function isModelReady(): boolean;
  export function cleanup(): Promise<void>;
}
