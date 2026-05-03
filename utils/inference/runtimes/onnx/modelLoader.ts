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
// - numThreads=1: Single-threaded (SharedArrayBuffer not available in service workers)
// - proxy=false: Direct execution (no worker proxy needed)
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'warning';

/**
 * WASM binary selection for service worker environment:
 *
 * We use the `.asyncify` variant because:
 * 1. Service workers are NOT cross-origin isolated (no COOP/COEP headers)
 * 2. SharedArrayBuffer is not available without cross-origin isolation
 * 3. The asyncify variant uses async/await patterns instead of SharedArrayBuffer
 *
 * The "threaded" in the filename is misleading - with numThreads=1, it runs single-threaded.
 * The asyncify variant is specifically designed for this use case.
 */
const WASM_PATH = '/ort/ort-wasm-simd-threaded.asyncify.wasm';

let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

async function preloadWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = fetch(WASM_PATH).then(res => {
      if (!res.ok) {
        throw new Error(`Failed to fetch WASM binary from ${WASM_PATH}: ${res.status} ${res.statusText}`);
      }
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
let loadingModelId: string | null = null; // Track which model is currently being loaded
let config: ModelMetadata = { ...DEFAULT_CONFIG };
let cachedBackend: string = 'unknown';

export async function discoverModels(): Promise<void> {
  const resolvedDefaultId = await discoverModelsShared(MODEL_PATHS, availableModels);
  // Update currentModelId if it was never explicitly set (still at initial default)
  if (currentModelId === DEFAULT_MODEL_ID) {
    currentModelId = resolvedDefaultId;
  }
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
    config = createConfigFromMetadata(metadata, DEFAULT_CONFIG);
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

  // Prevent concurrent loads for the SAME model
  // If loading a different model, don't use the existing promise (it would return wrong session)
  if (loadingPromise !== null && loadingModelId === currentModelId) {
    return loadingPromise;
  }

  const modelDef = availableModels.get(currentModelId);
  if (!modelDef) {
    throw new Error(`Model '${currentModelId}' not found`);
  }

  const modelPath = `${modelDef.basePath}/best.onnx`;

  loadingModelId = currentModelId;
  loadingPromise = (async () => {
    // Firefox's WebGPU is slow (~410ms vs WASM ~98ms), prefer WASM
    // Chrome's WebGPU is fast (~42ms vs WASM ~253ms), prefer WebGPU
    const isFirefox = navigator.userAgent.includes('Firefox');
    const backends = isFirefox ? (['wasm', 'webgpu'] as const) : (['webgpu', 'wasm'] as const);

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
          cachedBackend = backend;
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
    loadingModelId = null;
  }
}

export function isModelReady(): boolean {
  return session !== null;
}

export function getBackend(): string {
  return cachedBackend;
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
    // Wait for any in-progress load to complete before cleanup
    // This prevents the old session from being assigned after cleanup
    if (loadingPromise !== null) {
      await loadingPromise.catch(() => {});
    }

    if (session) {
      await session.release();
      session = null;
    }
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model cleanup:', error);
  }
}
