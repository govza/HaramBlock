import * as tf from '@tensorflow/tfjs';
import { load } from 'js-yaml';

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
  const metadata = await fetch(METADATA_PATH)
    .then(response => response.text())
    .then(text => load(text))
    .then(yamlData => yamlData as YamlMetadata)
    .catch(error => {
      logger.error('Failed to load metadata:', error);
      return null;
    });

  if (metadata) {
    config = {
      ...config,
      names: metadata.names || config.names,
      stride: metadata.stride || config.stride,
      imgsz: metadata.imgsz || config.imgsz,
    };
  }
}

async function setupBackend(): Promise<void> {
  try {
    // Dynamically register backends if available
    try {
      await import('@tensorflow/tfjs-backend-webgpu');
    } catch {
      /* empty */
    }
    try {
      await import('@tensorflow/tfjs-backend-webgl');
    } catch {
      /* empty */
    }

    // WebGL performance flags (no CPU forwarding, allow packing, prefer FP16)
    try {
      tf.env().set('WEBGL_CPU_FORWARD', false as unknown as number);
      tf.env().set('WEBGL_PACK', true as unknown as number);
      tf.env().set('WEBGL_FORCE_F16_TEXTURES', true as unknown as number);
    } catch {
      /* empty */
    }

    await tf.ready();

    // Try WebGPU first if registered
    try {
      await tf.setBackend('webgpu');
    } catch {
      /* empty */
    }
    if (tf.getBackend() !== 'webgpu') {
      // Fallback to WebGL
      await tf.setBackend('webgl');
    }

    logger.withTag('modelLoader').info(`TensorFlow backend: ${tf.getBackend()}`);
  } catch (e) {
    logger.withTag('modelLoader').warn('Failed to configure preferred backend, using default.', e);
  }
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

    const warmupResult = await modelToWarm.executeAsync(dummyInput);
    console.warn = originalWarn;

    if (Array.isArray(warmupResult)) {
      warmupResult.forEach(tensor => tensor.dispose());
    } else {
      warmupResult.dispose();
    }

    dummyInput.dispose();
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model warmup:', error);
  }
}

export async function initializeModel(): Promise<void> {
  // Initialize TF backend (prefer WebGPU, fallback to WebGL), then load the model
  try {
    await setupBackend();
    await loadModel();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await warmupModel(model!);
    logger.withTag('modelLoader').info('AI model loaded and ready for inference');
  } catch (error) {
    logger.withTag('modelLoader').error('Failed to load AI model:', error);
    throw error;
  }

  // Load metadata from YAML file
  await loadMetadata();
  logger
    .withTag('modelLoader')
    .info(
      `Metadata loaded successfully: ${Object.keys(config.names).length} classes, stride: ${config.stride}, input shape: ${config.imgsz.join('x')}`,
    );
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
