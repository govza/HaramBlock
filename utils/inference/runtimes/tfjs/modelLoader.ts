import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';
import { load } from 'js-yaml';

import { IS_CHROME } from '@/utils/constants/environment';
import { logger } from '@/utils/logger';

import type { ModelMetadata, YamlModelMetadata } from '@/utils/types';

export interface ModelDefinition {
  id: string;
  name: string;
  basePath: string;
  inputSize: number;
}

// Contract: each path contains best_web_model/model.json and metadata.yaml
const MODEL_PATHS = ['/models/aeef-y-640-82-20250124'];

const DEFAULT_MODEL_ID = 'y640';

// Built dynamically from metadata during discoverModels()
const availableModels: Map<string, ModelDefinition> = new Map();

let currentModelId: string = DEFAULT_MODEL_ID;
let model: tf.GraphModel | null = null;
let loadingPromise: Promise<{ model: tf.GraphModel; config: ModelMetadata }> | null = null;
let config: ModelMetadata = {
  names: { 0: 'person', 1: 'zfa', 2: 'zma' },
  imgsz: [640, 640],
  normalize: null,
  namesToCheck: ['zfa', 'zma'],
  outputShape: [160, 160],
  inputName: 'images',
  outputNames: {
    masks: 'output1',
  },
  stride: 32,
};

async function fetchMetadata(basePath: string): Promise<YamlModelMetadata> {
  const response = await fetch(`${basePath}/metadata.yaml`);
  if (!response.ok) {
    throw new Error(`Failed to fetch metadata: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  return load(text) as YamlModelMetadata;
}

function applyMetadataToConfig(metadata: YamlModelMetadata): void {
  const imgsz = metadata.imgsz || config.imgsz;
  const stride = metadata.stride || config.stride;
  config = {
    ...config,
    names: metadata.names || config.names,
    imgsz,
    normalize: metadata.normalize || null,
    outputShape: metadata.output_shape || [imgsz[0] / stride, imgsz[1] / stride],
    inputName: metadata.input_name || config.inputName,
    outputNames: {
      masks: metadata.output_names?.masks || 'output1',
    },
    stride,
  };
}

export async function discoverModels(): Promise<void> {
  if (availableModels.size > 0) {
    return; // Already discovered
  }

  const discoveries = await Promise.all(
    MODEL_PATHS.map(async basePath => {
      const metadata = await fetchMetadata(basePath);
      return {
        id: metadata.id,
        name: metadata.name,
        basePath,
        inputSize: metadata.imgsz[0],
        metadata,
      };
    }),
  );

  for (const modelDef of discoveries) {
    availableModels.set(modelDef.id, {
      id: modelDef.id,
      name: modelDef.name,
      basePath: modelDef.basePath,
      inputSize: modelDef.inputSize,
    });
  }

  logger
    .withTag('modelLoader')
    .info(`Discovered ${availableModels.size} models: ${[...availableModels.keys()].join(', ')}`);
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
    applyMetadataToConfig(metadata);
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

export function cleanup(): Promise<void> {
  try {
    if (model) {
      model.dispose();
      model = null;
    }
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model cleanup:', error);
  }
  return Promise.resolve();
}
