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
let cachedBackend: string = 'unknown';

// TFJS-specific runtime config detected during warmup
let maskTensorIndex: number = 1; // Default: output[1] contains mask prototypes
let maskLayoutNHWC: boolean = true; // Default: TFJS typically outputs NHWC

export async function discoverModels(): Promise<void> {
  const resolvedDefaultId = await discoverModelsShared(MODEL_PATHS, availableModels);
  // Update currentModelId if it was never explicitly set (still at initial default)
  if (currentModelId === DEFAULT_MODEL_ID) {
    currentModelId = resolvedDefaultId;
  }
}

async function setupBackend(): Promise<void> {
  // Chrome: WebGPU (best performance), Firefox: WebGL (no WebGPU in service workers)
  const backend = IS_CHROME ? 'webgpu' : 'webgl';
  await tf.setBackend(backend);
  await tf.ready();
  cachedBackend = tf.getBackend() ?? 'unknown';
  logger.withTag('modelLoader').info(`TensorFlow backend: ${cachedBackend}`);
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
        // Detect mask tensor index and layout from output shapes
        detectMaskTensorLayout(warmupResult);
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

/**
 * Detect which output tensor contains mask prototypes and its layout (NHWC vs NCHW).
 * Called once during warmup to avoid per-inference overhead.
 */
function detectMaskTensorLayout(outputs: tf.Tensor[]): void {
  const [outH, outW] = config.outputShape;

  for (let i = 1; i < outputs.length; i++) {
    const tensor = outputs[i];
    if (!tensor || tensor.rank !== 4) continue;

    const dims = tensor.shape;
    // Check for NHWC format: [batch, H, W, C] where H=outH, W=outW
    if (dims[1] === outH && dims[2] === outW) {
      maskTensorIndex = i;
      maskLayoutNHWC = true;
      logger.withTag('modelLoader').info(`Detected mask tensor at index ${i} with NHWC layout [${dims.join(',')}]`);
      return;
    }
    // Check for NCHW format: [batch, C, H, W] where H=outH, W=outW
    if (dims[2] === outH && dims[3] === outW) {
      maskTensorIndex = i;
      maskLayoutNHWC = false;
      logger.withTag('modelLoader').info(`Detected mask tensor at index ${i} with NCHW layout [${dims.join(',')}]`);
      return;
    }
  }

  logger
    .withTag('modelLoader')
    .warn(
      `Could not detect mask tensor with output shape [${outH}, ${outW}]. ` +
        `Using defaults (index=${maskTensorIndex}, NHWC=${maskLayoutNHWC}). ` +
        `Available shapes: ${outputs.map(t => `[${t.shape.join(',')}]`).join(', ')}`,
    );
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

export function getBackend(): string {
  return cachedBackend;
}

export function getMaskTensorIndex(): number {
  return maskTensorIndex;
}

export function isMaskLayoutNHWC(): boolean {
  return maskLayoutNHWC;
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
    // Reset runtime config to defaults for next model load
    maskTensorIndex = 1;
    maskLayoutNHWC = true;
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model cleanup:', error);
  }
  return Promise.resolve();
}
