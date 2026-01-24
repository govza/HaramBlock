// Polyfills MUST be imported first (before onnxruntime-web)
import '@/utils/inference/serviceWorkerPolyfills';

import { load } from 'js-yaml';
// WebGPU bundle import - resolved via wxt.config.ts alias (no dynamic imports)
import * as ort from 'onnxruntime-web';

import { logger } from '@/utils/logger';

import type { ModelMetadata, YamlModelMetadata } from '@/utils/types';

// Configure ONNX Runtime for service worker environment
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

// Pre-load WASM binary (WebGPU still needs WASM for some operations)
// This avoids dynamic imports which are disallowed in service workers
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

async function preloadWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = fetch('/ort/ort-wasm-simd-threaded.asyncify.wasm').then(res => {
      if (!res.ok) throw new Error(`Failed to fetch WASM: ${res.status}`);
      return res.arrayBuffer();
    });
  }
  return wasmBinaryPromise;
}

export interface ModelDefinition {
  id: string;
  name: string;
  basePath: string;
  inputSize: number;
}

// Contract: each path contains best.onnx and metadata.yaml
const MODEL_PATHS = ['/models/afeef-y-320-3-20250124', '/models/aeef-y-640-82-20250124'];

const DEFAULT_MODEL_ID = 'y640';

// Built dynamically from metadata during discoverModels()
const availableModels: Map<string, ModelDefinition> = new Map();

let currentModelId: string = DEFAULT_MODEL_ID;
let session: ort.InferenceSession | null = null;
let loadingPromise: Promise<{ session: ort.InferenceSession; config: ModelMetadata }> | null = null;
let config: ModelMetadata = {
  names: { 0: 'person', 1: 'zfa', 2: 'zma' },
  imgsz: [320, 320],
  normalize: null,
  namesToCheck: ['zfa', 'zma'],
  outputShape: [80, 80],
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

  for (const model of discoveries) {
    availableModels.set(model.id, {
      id: model.id,
      name: model.name,
      basePath: model.basePath,
      inputSize: model.inputSize,
    });
  }

  logger
    .withTag('modelLoader')
    .info(`Discovered ${availableModels.size} models: ${[...availableModels.keys()].join(', ')}`);
}

async function warmupModel(sessionToWarm: ort.InferenceSession): Promise<void> {
  try {
    const [height, width] = config.imgsz;

    // Create dummy input tensor [1, 3, height, width] NCHW format
    const dummyData = new Float32Array(1 * 3 * height * width);
    const dummyTensor = new ort.Tensor('float32', dummyData, [1, 3, height, width]);

    // Run warmup inference
    const feeds: Record<string, ort.Tensor> = { [config.inputName]: dummyTensor };
    const results = await sessionToWarm.run(feeds);

    // Dispose results
    for (const key of Object.keys(results)) {
      results[key]?.dispose();
    }
    dummyTensor.dispose();

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
    // Pre-load WASM binary before creating session (WebGPU needs WASM for some operations)
    logger.withTag('modelLoader').info('Pre-loading WASM binary...');
    const wasmBinary = await preloadWasmBinary();
    ort.env.wasm.wasmBinary = wasmBinary;
    logger.withTag('modelLoader').info(`WASM binary loaded: ${wasmBinary.byteLength} bytes`);

    const { session: loadedSession } = await loadModel();
    await warmupModel(loadedSession);
    logger.withTag('modelLoader').info('ONNX model loaded and ready for inference');
  } catch (error) {
    logger.withTag('modelLoader').error('Failed to load ONNX model:', error);
    throw error;
  }
}

export async function loadModel(): Promise<{ session: ort.InferenceSession; config: ModelMetadata }> {
  if (session !== null) {
    return { session, config };
  }

  // Prevent concurrent loads
  if (loadingPromise !== null) {
    return loadingPromise;
  }

  const modelDef = availableModels.get(currentModelId);
  if (!modelDef) {
    throw new Error(`Model '${currentModelId}' not found`);
  }

  const modelPath = `${modelDef.basePath}/best.onnx`;

  loadingPromise = (async () => {
    // Try WebGPU first, fall back to WASM
    const backends = ['webgpu', 'wasm'] as const;

    for (const backend of backends) {
      try {
        logger.withTag('modelLoader').info(`Loading ${modelDef.name} with ${backend.toUpperCase()} backend...`);

        // eslint-disable-next-line no-await-in-loop -- Sequential fallback: try WebGPU first, then WASM
        const loadedSession = await ort.InferenceSession.create(modelPath, {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
          logSeverityLevel: 4, // Fatal only - suppress expected EP assignment warnings
        });

        if (loadedSession) {
          session = loadedSession;
          logger.withTag('modelLoader').info(`Model loaded successfully with ${backend.toUpperCase()}`);
          return { session, config };
        }
      } catch (error) {
        logger.withTag('modelLoader').warn(`Failed to load model with ${backend.toUpperCase()}:`, error);
        if (backend === 'wasm') {
          throw error; // No more fallbacks
        }
      }
    }

    throw new Error('Model not loaded');
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

export function isModelReady(): boolean {
  return session !== null;
}

export function getCurrentModelId(): string {
  return currentModelId;
}

export function getAvailableModels(): ModelDefinition[] {
  return [...availableModels.values()];
}

export async function switchModel(modelId: string): Promise<void> {
  if (modelId === currentModelId && session !== null) {
    logger.withTag('modelLoader').info(`Model ${modelId} is already loaded`);
    return;
  }

  logger.withTag('modelLoader').info(`Switching model from ${currentModelId} to ${modelId}...`);

  // Release current session
  await cleanup();

  // Load new model
  await initializeModel(modelId);

  logger.withTag('modelLoader').info(`Successfully switched to model ${modelId}`);
}

export { ort };

export async function cleanup(): Promise<void> {
  try {
    if (session) {
      await session.release();
      session = null;
    }
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model cleanup:', error);
  }
}
