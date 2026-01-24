import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';

import { IS_CHROME } from '@/utils/constants/environment';
import {
  createConfigFromMetadata,
  DEFAULT_CONFIG,
  DEFAULT_MODEL_ID,
  discoverModels as discoverModelsShared,
  fetchMetadata,
  MODEL_PATHS,
  type ModelDefinition,
} from '@/utils/inference/shared/modelRegistry';
import { logger } from '@/utils/logger';

import type { ModelMetadata } from '@/utils/types';

export type { ModelDefinition };

// Built dynamically from metadata during discoverModels()
const availableModels: Map<string, ModelDefinition> = new Map();

let currentModelId: string = DEFAULT_MODEL_ID;
let model: tf.GraphModel | null = null;
let loadingPromise: Promise<{ model: tf.GraphModel; config: ModelMetadata }> | null = null;
let config: ModelMetadata = { ...DEFAULT_CONFIG };

export async function discoverModels(): Promise<void> {
  await discoverModelsShared(MODEL_PATHS, availableModels);
}

async function setupBackend(): Promise<void> {
  // Chrome: WebGPU (best performance), Firefox: WebGL (no WebGPU in service workers)
  const backend = IS_CHROME ? 'webgpu' : 'webgl';
  await tf.setBackend(backend);
  await tf.ready();
  logger.withTag('modelLoader').info(`TensorFlow backend: ${tf.getBackend()}`);
}

async function warmupModel(modelToWarm: tf.GraphModel): Promise<void> {
  try {
    const inputSpec = modelToWarm.inputs?.[0];
    if (!inputSpec || !inputSpec.shape) {
      return;
    }

    const inputShape = inputSpec.shape;
    const actualShape = inputShape.map((dim: number | null) => (dim === -1 || dim === null ? 1 : dim));
    const dummyInput = tf.randomUniform(actualShape, 0, 1, 'float32');

    // Suppress false warnings during warmup
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      const warmupResult = await modelToWarm.executeAsync(dummyInput);

      if (Array.isArray(warmupResult)) {
        warmupResult.forEach(tensor => tensor.dispose());
      } else {
        warmupResult.dispose();
      }
    } finally {
      console.warn = originalWarn;
    }

    dummyInput.dispose();
    logger.withTag('modelLoader').info('Model warmup completed');
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model warmup:', error);
  }
}

export async function initializeModel(modelId?: string): Promise<void> {
  // Discover models first if not already done
  await discoverModels();

  const targetModelId = modelId ?? currentModelId;
  const modelDef = availableModels.get(targetModelId);

  if (!modelDef) {
    throw new Error(`Model '${targetModelId}' not found. Available: ${[...availableModels.keys()].join(', ')}`);
  }

  try {
    const metadata = await fetchMetadata(modelDef.basePath);
    config = createConfigFromMetadata(metadata, config);
    currentModelId = targetModelId;
    logger
      .withTag('modelLoader')
      .info(
        `Metadata loaded for ${modelDef.name}: ${Object.keys(config.names).length} classes, input shape: ${config.imgsz.join('x')}`,
      );
  } catch (error) {
    logger.withTag('modelLoader').error('Failed to load metadata:', error);
    throw error;
  }

  try {
    await setupBackend();
    const { model: loadedModel } = await loadModel();
    await warmupModel(loadedModel);
    logger.withTag('modelLoader').info('TensorFlow.js model loaded and ready for inference');
  } catch (error) {
    logger.withTag('modelLoader').error('Failed to load TensorFlow.js model:', error);
    throw error;
  }
}

export async function loadModel(): Promise<{ model: tf.GraphModel; config: ModelMetadata }> {
  if (model !== null) {
    return { model, config };
  }

  // Prevent concurrent loads
  if (loadingPromise !== null) {
    return loadingPromise;
  }

  const modelDef = availableModels.get(currentModelId);
  if (!modelDef) {
    throw new Error(`Model '${currentModelId}' not found`);
  }

  const modelPath = `${modelDef.basePath}/best_web_model/model.json`;

  loadingPromise = (async () => {
    logger.withTag('modelLoader').info(`Loading ${modelDef.name} from ${modelPath}...`);

    const loadedModel = await tf.loadGraphModel(modelPath);

    if (!loadedModel) {
      throw new Error('Model not loaded');
    }

    model = loadedModel;
    logger.withTag('modelLoader').info(`Model loaded successfully`);
    return { model, config };
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

export function isModelReady(): boolean {
  return model !== null;
}

export function getCurrentModelId(): string {
  return currentModelId;
}

export function getAvailableModels(): ModelDefinition[] {
  return [...availableModels.values()];
}

export async function switchModel(modelId: string): Promise<void> {
  if (modelId === currentModelId && model !== null) {
    logger.withTag('modelLoader').info(`Model ${modelId} is already loaded`);
    return;
  }

  logger.withTag('modelLoader').info(`Switching model from ${currentModelId} to ${modelId}...`);

  // Release current model
  await cleanup();

  // Load new model
  await initializeModel(modelId);

  logger.withTag('modelLoader').info(`Successfully switched to model ${modelId}`);
}

// eslint-disable-next-line @typescript-eslint/require-await -- Async for API consistency with ONNX runtime
export async function cleanup(): Promise<void> {
  try {
    if (model) {
      model.dispose();
      model = null;
    }
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model cleanup:', error);
  }
}
