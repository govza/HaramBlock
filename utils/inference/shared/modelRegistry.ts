import { load } from 'js-yaml';

import { getLogger } from '@/utils/telemetry';

import type { IModelMetadata, IYamlModelMetadata, ModelTask } from '@/utils/types';

const log = getLogger('modelLoader');

/**
 * A shipped model as discovered from its folder: the id settings refer to, plus the weights version
 * (the folder's date suffix) the video cache keys its samples by, and the compatibility key that
 * decides which other versions' cached samples it may read.
 */
export interface ModelDefinition {
  id: string;
  name: string;
  basePath: string;
  inputSize: number;
  version: string;
  compatibilityKey: string;
}

const MODEL_FOLDER_VERSION = /-(\d{8})$/;

export const modelVersionOf = (basePath: string): string => MODEL_FOLDER_VERSION.exec(basePath)?.[1] ?? 'unversioned';

export const cacheModelIdOf = (model: Pick<ModelDefinition, 'id' | 'version'>): string =>
  `${model.id}@${model.version}`;

const NON_TARGET_CLASSES = new Set(['background', 'safe_person', 'person']);

const targetClassesOf = (names: Record<number, string>): string[] =>
  Object.values(names).filter(name => !NON_TARGET_CLASSES.has(name));

const taskOf = (metadata: IYamlModelMetadata): ModelTask => (metadata.task === 'semantic' ? 'semantic' : 'segment');

export const compatibilityKeyOf = (metadata: IYamlModelMetadata): string =>
  `${taskOf(metadata)}:${targetClassesOf(metadata.names ?? {})
    .sort()
    .join(',')}`;

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
export function computeBatchCap(config: IModelMetadata): number {
  if (!config.dynamicBatch) return 1;
  return BATCH_CAPS[config.imgsz[0]] ?? 4;
}

/** Preferred default model ID. Falls back to first discovered model if not found. */
export const DEFAULT_MODEL_ID = 'sem-i320';

/** Default model configuration used before metadata is loaded */
export const DEFAULT_CONFIG: IModelMetadata = {
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
export async function fetchMetadata(basePath: string): Promise<IYamlModelMetadata> {
  const response = await fetch(`${basePath}/metadata.yaml`);
  if (!response.ok) {
    throw new Error(`Failed to fetch metadata: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  return load(text) as IYamlModelMetadata;
}

/**
 * Create a IModelMetadata config from YAML metadata.
 * Pure function - returns a new config object.
 */
export function createConfigFromMetadata(metadata: IYamlModelMetadata, defaults: IModelMetadata): IModelMetadata {
  const imgsz = metadata.imgsz || defaults.imgsz;
  const stride = metadata.stride || defaults.stride;
  const names = metadata.names || defaults.names;
  const task = taskOf(metadata);
  return {
    ...defaults,
    names,
    imgsz,
    normalize: metadata.normalize || null,
    namesToCheck: targetClassesOf(names),
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
        version: modelVersionOf(basePath),
        compatibilityKey: compatibilityKeyOf(metadata),
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
