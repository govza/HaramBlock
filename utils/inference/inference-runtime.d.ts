/**
 * Type declarations for @inference-runtime alias.
 * The implementation is in utils/inference/runtimes/onnx
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
  export function getBackend(): string;
  export function cleanup(): Promise<void>;
}
