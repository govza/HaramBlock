import { load } from 'js-yaml';

import { getLogger } from '@/utils/telemetry';

import type { ModelMetadata, YamlModelMetadata } from '@/utils/types';

const log = getLogger('modelLoader');

export interface ModelDefinition {
  id: string;
  name: string;
  basePath: string;
  inputSize: number;
}

const NON_TARGET_CLASSES = new Set(['background', 'safe_person', 'person']);

/**
 * Model directory paths - each contains metadata.yaml and model files.
 * This is the SINGLE SOURCE OF TRUTH for available models.
 */
export const MODEL_PATHS = [
  '/models/afeef-y26-sem-320-20260607',
  '/models/afeef-y26-sem-448-20260607',
  '/models/afeef-y26-sem-640-20260607',
];

/**
 * Adaptive-batching caps by model input size, measured in the batch sweep (docs/INFERENCE_PIPELINE.md): smaller models
 * scale further before throughput plateaus. Only applied to dynamic-batch exports.
 */
const BATCH_CAPS: Record<number, number> = { 320: 8, 448: 4, 640: 4 };

/** Max images per batched session.run for the active model (1 = no batching / static export). */
export function computeBatchCap(config: ModelMetadata): number {
  if (!config.dynamicBatch) return 1;
  return BATCH_CAPS[config.imgsz[0]] ?? 4;
}

/** Preferred default model ID. Falls back to first discovered model if not found. */
export const DEFAULT_MODEL_ID = 'sem-i320';

/** Default model configuration used before metadata is loaded */
export const DEFAULT_CONFIG: ModelMetadata = {
  names: { 0: 'background', 1: 'aurat_female', 2: 'aurat_male', 3: 'safe_person' },
  imgsz: [320, 320],
  normalize: null,
  namesToCheck: ['aurat_female', 'aurat_male'],
  outputShape: [320, 320],
  inputName: 'images',
  outputNames: {
    detections: 'output0',
    masks: 'output1',
  },
  stride: 32,
  task: 'semantic',
  dynamicBatch: false,
};

/**
 * Fetch and parse model metadata from YAML file.
 */
export async function fetchMetadata(basePath: string): Promise<YamlModelMetadata> {
  const response = await fetch(`${basePath}/metadata.yaml`);
  if (!response.ok) {
    throw new Error(`Failed to fetch metadata: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  return load(text) as YamlModelMetadata;
}

/**
 * Create a ModelMetadata config from YAML metadata.
 * Pure function - returns a new config object.
 */
export function createConfigFromMetadata(metadata: YamlModelMetadata, defaults: ModelMetadata): ModelMetadata {
  const imgsz = metadata.imgsz || defaults.imgsz;
  const stride = metadata.stride || defaults.stride;
  const names = metadata.names || defaults.names;
  const task = metadata.task === 'semantic' ? 'semantic' : 'segment';
  return {
    ...defaults,
    names,
    imgsz,
    normalize: metadata.normalize || null,
    namesToCheck: Object.values(names).filter(name => !NON_TARGET_CLASSES.has(name)),
    outputShape: metadata.output_shape || [imgsz[0] / stride, imgsz[1] / stride],
    inputName: metadata.input_name || defaults.inputName,
    outputNames: {
      detections: metadata.output_names?.detections || 'output0',
      masks: metadata.output_names?.masks || 'output1',
    },
    stride,
    task,
    dynamicBatch: metadata.args?.dynamic ?? false,
  };
}

/**
 * Discover available models by fetching metadata from all model paths.
 * Populates the provided map with discovered models.
 * @returns The resolved default model ID (validates DEFAULT_MODEL_ID exists, falls back to first model)
 */
export async function discoverModels(
  modelPaths: string[],
  availableModels: Map<string, ModelDefinition>,
): Promise<string> {
  if (availableModels.size > 0) {
    return resolveDefaultModelId(availableModels);
  }

  const discoveries = await Promise.all(
    modelPaths.map(async basePath => {
      const metadata = await fetchMetadata(basePath);
      return {
        id: metadata.id,
        name: metadata.name,
        basePath,
        inputSize: metadata.imgsz[0],
      };
    }),
  );

  for (const model of discoveries) {
    availableModels.set(model.id, model);
  }

  log.info('model.discovery.completed', { modelCount: availableModels.size, modelIds: [...availableModels.keys()] });

  return resolveDefaultModelId(availableModels);
}

/**
 * Resolve the default model ID, falling back to first discovered model if preferred default doesn't exist.
 */
function resolveDefaultModelId(availableModels: Map<string, ModelDefinition>): string {
  if (availableModels.has(DEFAULT_MODEL_ID)) {
    return DEFAULT_MODEL_ID;
  }

  const firstModelId = availableModels.keys().next().value;
  if (firstModelId) {
    log.warn('model.default.fallback', { defaultModelId: DEFAULT_MODEL_ID, fallbackModelId: firstModelId });
    return firstModelId;
  }

  throw new Error('No models discovered');
}
