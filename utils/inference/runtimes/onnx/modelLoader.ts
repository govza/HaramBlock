// Polyfills MUST be imported first (before onnxruntime-web)
import '@/utils/inference/serviceWorkerPolyfills';

// WebGPU bundle import - resolved via wxt.config.ts alias (no dynamic imports)
import * as ort from 'onnxruntime-web';

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

export type { ModelDefinition };

// Built dynamically from metadata during discoverModels()
const availableModels: Map<string, ModelDefinition> = new Map();

let currentModelId: string = DEFAULT_MODEL_ID;
let session: ort.InferenceSession | null = null;
let loadingPromise: Promise<{ session: ort.InferenceSession; config: ModelMetadata }> | null = null;
let config: ModelMetadata = { ...DEFAULT_CONFIG };

export async function discoverModels(): Promise<void> {
  await discoverModelsShared(MODEL_PATHS, availableModels);
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
