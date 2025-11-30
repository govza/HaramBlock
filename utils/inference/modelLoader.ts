import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';
import { load } from 'js-yaml';

import { IS_CHROME } from '@/utils/constants/environment';
import { logger } from '@/utils/logger';

import type { Metadata, YamlMetadata } from '@/utils/types';

const MODEL_PATH = '/models/afeef-11m-segment-int8/model.json';
const METADATA_PATH = '/models/afeef-11m-segment-int8/metadata.yaml';

let model: tf.GraphModel | null = null;
let config: Metadata = {
  // Values filled in after loading metadata
  names: [],
  stride: 32,
  imgsz: [640, 640],

  // Values that are fixed and do not change
  outputShape: [160, 160, 32],
  namesToCheck: ['zfa', 'zma'],
};

async function loadMetadata(): Promise<void> {
  const response = await fetch(METADATA_PATH);
  if (!response.ok) {
    throw new Error(`Failed to fetch metadata: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const metadata = load(text) as YamlMetadata;

  config = {
    ...config,
    names: metadata.names || config.names,
    stride: metadata.stride || config.stride,
    imgsz: metadata.imgsz || config.imgsz,
  };
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
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model warmup:', error);
  }
}

export async function initializeModel(): Promise<void> {
  try {
    await loadMetadata();
    logger
      .withTag('modelLoader')
      .info(
        `Metadata loaded successfully: ${Object.keys(config.names).length} classes, stride: ${config.stride}, input shape: ${config.imgsz.join('x')}`,
      );
  } catch (error) {
    logger.withTag('modelLoader').error('Failed to load metadata:', error);
    throw error;
  }

  // Initialize TF backend (prefer WebGPU, fallback to WebGL), then load the model
  try {
    await setupBackend();
    const loadedModel = await loadModel();
    await warmupModel(loadedModel);
    logger.withTag('modelLoader').info('AI model loaded and ready for inference');
  } catch (error) {
    logger.withTag('modelLoader').error('Failed to load AI model:', error);
    throw error;
  }
}

export async function loadModel(): Promise<tf.GraphModel> {
  if (model === null) {
    const loadedModel = await tf.loadGraphModel(MODEL_PATH);

    if (!loadedModel) {
      throw new Error('Model not loaded');
    }

    model = loadedModel;
  }
  return model;
}

export function getModel(): tf.GraphModel | null {
  return model;
}

export function isModelReady(): boolean {
  return model !== null;
}

export function cleanup(): void {
  try {
    if (model) {
      model.dispose();
      model = null;
    }
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model cleanup:', error);
  }
}

export function getModelConfig(): Metadata {
  return config;
}
