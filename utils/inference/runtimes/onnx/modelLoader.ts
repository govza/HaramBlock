// Polyfills MUST be imported first (before onnxruntime-web)
import '@/utils/inference/serviceWorkerPolyfills';

// WebGPU bundle import - resolved via wxt.config.ts alias (no dynamic imports)
import * as ort from 'onnxruntime-web';

import { runWithQueuePoke } from '@/utils/inference/runtimes/onnx/webgpuQueuePoker';
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

interface ModelRuntime {
  session: ort.InferenceSession;
  config: ModelMetadata;
  modelId: string;
  backend: Backend;
}

interface ModelRuntimeLease extends ModelRuntime {
  release: () => void;
}

let currentModelId: string = DEFAULT_MODEL_ID;
let session: ort.InferenceSession | null = null;
let sessionConfig: ModelMetadata | null = null;
let sessionModelId: string | null = null;
let loadingPromise: Promise<ModelRuntime> | null = null;
let loadingModelId: string | null = null; // Track which model is currently being loaded
let config: ModelMetadata = { ...DEFAULT_CONFIG };
let cachedBackend: Backend | 'unknown' = 'unknown';
let activeRuntimeLeases = 0;
let switchPromise: Promise<void> | null = null;
let idleResolvers: Array<() => void> = [];

type Backend = 'webgpu' | 'wasm';

function getWarmupRuns(): number {
  return Math.max(1, Math.floor(__WEBGPU_WARMUP_RUNS__));
}

function getBackendPreference(): Backend[] {
  if (!('gpu' in navigator)) {
    logger.withTag('modelLoader').info('WebGPU API unavailable, using WASM backend');
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

function releaseRuntimeLease(): void {
  activeRuntimeLeases = Math.max(0, activeRuntimeLeases - 1);
  if (activeRuntimeLeases === 0) {
    const resolvers = idleResolvers;
    idleResolvers = [];
    resolvers.forEach(resolve => resolve());
  }
}

async function waitForRuntimeLeasesToDrain(): Promise<void> {
  if (activeRuntimeLeases === 0) return;
  await new Promise<void>(resolve => idleResolvers.push(resolve));
}

export async function acquireModelRuntime(): Promise<ModelRuntimeLease> {
  while (switchPromise) {
    // eslint-disable-next-line no-await-in-loop -- Wait through any back-to-back model switches.
    await switchPromise;
  }

  activeRuntimeLeases += 1;

  try {
    const runtime = await loadModel();
    return {
      ...runtime,
      release: releaseRuntimeLease,
    };
  } catch (error) {
    releaseRuntimeLease();
    throw error;
  }
}

// Firefox delivers WebGPU readbacks on a ~100ms poll tick; see webgpuQueuePoker.ts
function needsFirefoxQueuePoke(): boolean {
  return import.meta.env.FIREFOX && cachedBackend === 'webgpu';
}

// Serializes session.run() calls. No onnxruntime-web bundle supports overlapping runs on a session
// (asyncify has a single suspension stack; JSEP hangs) - see docs/INFERENCE_PIPELINE.md. Queue concurrency (>1)
// overlaps the surrounding CPU work, but the GPU run itself must stay single-flight. The chain is
// mapped to a never-rejecting promise so one failed run cannot break serialization for the next.
let runLock: Promise<void> = Promise.resolve();

function withRunLock<T>(run: () => Promise<T>): Promise<T> {
  const result = runLock.then(run);
  runLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function runSession(
  sessionToRun: ort.InferenceSession,
  feeds: Record<string, ort.Tensor>,
): Promise<ort.InferenceSession.OnnxValueMapType> {
  return withRunLock(async () => {
    if (needsFirefoxQueuePoke()) {
      // Fetch the device on every run: ONNX Runtime creates a NEW GPUDevice after a model
      // switch (session release + create), and poking a stale device's queue does nothing.
      // The getter resolves immediately since the WebGPU session already exists here.
      const gpuDevice = await ort.env.webgpu.device;
      return runWithQueuePoke(gpuDevice, () => sessionToRun.run(feeds));
    }
    return sessionToRun.run(feeds);
  });
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

async function runSingleWarmup(
  sessionToWarm: ort.InferenceSession,
  modelConfig: ModelMetadata,
  height: number,
  width: number,
): Promise<number> {
  const dummyData = new Float32Array(1 * 3 * height * width);
  const dummyTensor = new ort.Tensor('float32', dummyData, [1, 3, height, width]);
  const feeds: Record<string, ort.Tensor> = { [modelConfig.inputName]: dummyTensor };

  const t0 = performance.now();
  const results = await runSession(sessionToWarm, feeds);
  const elapsed = performance.now() - t0;

  for (const key of Object.keys(results)) {
    results[key]?.dispose();
  }
  dummyTensor.dispose();
  return elapsed;
}

async function warmupModel(sessionToWarm: ort.InferenceSession, modelConfig: ModelMetadata): Promise<void> {
  try {
    const [height, width] = modelConfig.imgsz;

    const warmupTimes: number[] = [];
    const warmupRuns = getWarmupRuns();

    for (let i = 0; i < warmupRuns; i++) {
      // eslint-disable-next-line no-await-in-loop -- Warmup intentionally serializes runs to prime shader variants.
      warmupTimes.push(await runSingleWarmup(sessionToWarm, modelConfig, height, width));
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

  // Preserve the last good model. currentModelId/config are advanced as soon as metadata
  // loads, but loadModel() can still fail afterwards (corrupt model, no usable backend).
  // Roll back on failure so a fallback doesn't re-target the model that just failed.
  const previousModelId = currentModelId;
  const previousConfig = config;

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

    const { session: loadedSession, config: loadedConfig } = await loadModel();
    await warmupModel(loadedSession, loadedConfig);

    if (import.meta.env.DEV) {
      logger.withTag('profiler').info(`Total init E2E: ${(performance.now() - initT0).toFixed(1)}ms`);
    }

    logger
      .withTag('modelLoader')
      .info(
        `ONNX model loaded and ready for inference: ${currentModelId} (${modelDef.name}, ${cachedBackend.toUpperCase()})`,
      );
  } catch (error) {
    currentModelId = previousModelId;
    config = previousConfig;
    logger.withTag('modelLoader').error('Failed to load ONNX model:', error);
    throw error;
  }
}

export async function loadModel(): Promise<ModelRuntime> {
  if (session !== null) {
    return {
      session,
      config: sessionConfig ?? config,
      modelId: sessionModelId ?? currentModelId,
      backend: cachedBackend === 'unknown' ? 'wasm' : cachedBackend,
    };
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
  const targetConfig = config;
  const targetModelId = currentModelId;

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
          sessionConfig = targetConfig;
          sessionModelId = targetModelId;
          cachedBackend = backend;
          if (import.meta.env.DEV) {
            logger
              .withTag('profiler')
              .info(`Session creation (${backend}): ${(performance.now() - sessionT0).toFixed(1)}ms`);
          }
          logger.withTag('modelLoader').info(`Model loaded successfully with ${backend.toUpperCase()}`);
          return { session, config: targetConfig, modelId: targetModelId, backend };
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

// Config of the active session, used to size adaptive batches. Falls back to the latest loaded
// metadata before the first session exists.
export function getActiveModelConfig(): ModelMetadata {
  return sessionConfig ?? config;
}

export function getAvailableModels(): ModelDefinition[] {
  return [...availableModels.values()];
}

export async function switchModel(modelId: string): Promise<void> {
  if (modelId === currentModelId && session !== null) {
    logger.withTag('modelLoader').info(`Model ${modelId} is already loaded`);
    return;
  }

  if (switchPromise) {
    await switchPromise;
  }

  if (modelId === currentModelId && session !== null) {
    logger.withTag('modelLoader').info(`Model ${modelId} is already loaded`);
    return;
  }

  const previousModelId = currentModelId;
  logger.withTag('modelLoader').info(`Switching model from ${previousModelId} to ${modelId}...`);

  switchPromise = (async () => {
    await waitForRuntimeLeasesToDrain();

    // Release current session
    await cleanup();

    // Load new model
    await initializeModel(modelId);
  })();

  try {
    await switchPromise;
  } finally {
    switchPromise = null;
  }

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
      sessionConfig = null;
      sessionModelId = null;
    }
  } catch (error) {
    logger.withTag('modelLoader').error('Error during model cleanup:', error);
  }
}
