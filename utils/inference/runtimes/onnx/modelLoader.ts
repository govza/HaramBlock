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

declare const __ENABLE_FIREFOX_WEBGPU__: boolean;
declare const __WEBGPU_WARMUP_RUNS__: number;

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

type Backend = 'webgpu' | 'wasm';

function getWarmupRuns(): number {
  return Math.max(1, Math.floor(__WEBGPU_WARMUP_RUNS__));
}

function getBackendPreference(): Backend[] {
  if (!('gpu' in navigator)) {
    logger.withTag('modelLoader').info('WebGPU API unavailable, using WASM backend');
    return ['wasm'];
  }

  if (import.meta.env.FIREFOX && !__ENABLE_FIREFOX_WEBGPU__) {
    logger.withTag('modelLoader').info('Firefox WebGPU disabled for default builds, using WASM backend');
    return ['wasm'];
  }

  return ['webgpu', 'wasm'];
}

function createSessionOptions(backend: Backend): ort.InferenceSession.SessionOptions {
  return {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
    logSeverityLevel: 4, // Fatal only - suppress expected EP assignment warnings
  };
}

function getWarmupLabel(index: number): string {
  if (index === 0) return 'shader compile';
  if (index === 1) return 'steady-state';
  return 'extra';
}

export async function discoverModels(): Promise<void> {
  const resolvedDefaultId = await discoverModelsShared(MODEL_PATHS, availableModels);
  // Update currentModelId if it was never explicitly set (still at initial default)
  if (currentModelId === DEFAULT_MODEL_ID) {
    currentModelId = resolvedDefaultId;
  }
}

async function runSingleWarmup(sessionToWarm: ort.InferenceSession, height: number, width: number): Promise<number> {
  const dummyData = new Float32Array(1 * 3 * height * width);
  const dummyTensor = new ort.Tensor('float32', dummyData, [1, 3, height, width]);
  const feeds: Record<string, ort.Tensor> = { [config.inputName]: dummyTensor };

  const t0 = performance.now();
  const results = await sessionToWarm.run(feeds);
  const elapsed = performance.now() - t0;

  for (const key of Object.keys(results)) {
    results[key]?.dispose();
  }
  dummyTensor.dispose();
  return elapsed;
}

async function warmupModel(sessionToWarm: ort.InferenceSession): Promise<void> {
  try {
    const [height, width] = config.imgsz;

    const warmupTimes: number[] = [];
    const warmupRuns = getWarmupRuns();

    for (let i = 0; i < warmupRuns; i++) {
      // eslint-disable-next-line no-await-in-loop -- Warmup intentionally serializes runs to prime shader variants.
      warmupTimes.push(await runSingleWarmup(sessionToWarm, height, width));
    }

    if (import.meta.env.DEV) {
      warmupTimes.forEach((time, index) => {
        const label = getWarmupLabel(index);
        logger.withTag('profiler').info(`Warmup ${index + 1} (${label}): ${time.toFixed(1)}ms`);
      });
    }

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
    const initT0 = performance.now();

    // Pre-load WASM binary before creating session (WebGPU needs WASM for some operations)
    logger.withTag('modelLoader').info('Pre-loading WASM binary...');
    const wasmBinary = await preloadWasmBinary();
    ort.env.wasm.wasmBinary = wasmBinary;
    logger.withTag('modelLoader').info(`WASM binary loaded: ${wasmBinary.byteLength} bytes`);

    const { session: loadedSession } = await loadModel();
    await warmupModel(loadedSession);

    if (import.meta.env.DEV) {
      logger.withTag('profiler').info(`Total init E2E: ${(performance.now() - initT0).toFixed(1)}ms`);
    }

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
    const backends = getBackendPreference();

    for (const backend of backends) {
      try {
        logger.withTag('modelLoader').info(`Loading ${modelDef.name} with ${backend.toUpperCase()} backend...`);
        if (import.meta.env.DEV && backend === 'webgpu') {
          logger.withTag('profiler').info(`WebGPU warmups: ${getWarmupRuns()}`);
        }

        const sessionT0 = performance.now();
        // eslint-disable-next-line no-await-in-loop -- Sequential fallback: try WebGPU first, then WASM
        const loadedSession = await ort.InferenceSession.create(modelPath, createSessionOptions(backend));

        if (loadedSession) {
          session = loadedSession;
          cachedBackend = backend;
          if (import.meta.env.DEV) {
            logger
              .withTag('profiler')
              .info(`Session creation (${backend}): ${(performance.now() - sessionT0).toFixed(1)}ms`);
          }
          logger.withTag('modelLoader').info(`Model loaded successfully with ${backend.toUpperCase()}`);
          return { session, config };
        }
      } catch (error) {
        logger.withTag('modelLoader').warn(`Failed to load model with ${backend.toUpperCase()}:`, error);
        if (backend === backends[backends.length - 1]) {
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
