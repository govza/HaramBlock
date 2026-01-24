import { load } from 'js-yaml';

import { logger } from '@/utils/logger';

import type { ModelMetadata, YamlModelMetadata } from '@/utils/types';

export interface ModelDefinition {
  id: string;
  name: string;
  basePath: string;
  inputSize: number;
}

/** Model directory paths - each contains metadata.yaml and model files */
export const MODEL_PATHS = ['/models/afeef-y-320-3-20250124', '/models/aeef-y-640-82-20250124'];

export const DEFAULT_MODEL_ID = 'y640';

/** Default model configuration used before metadata is loaded */
export const DEFAULT_CONFIG: ModelMetadata = {
  names: { 0: 'person', 1: 'zfa', 2: 'zma' },
  imgsz: [640, 640],
  normalize: null,
  namesToCheck: ['zfa', 'zma'],
  outputShape: [160, 160],
  inputName: 'images',
  outputNames: {
    masks: 'output1',
  },
  stride: 32,
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
  return {
    ...defaults,
    names: metadata.names || defaults.names,
    imgsz,
    normalize: metadata.normalize || null,
    outputShape: metadata.output_shape || [imgsz[0] / stride, imgsz[1] / stride],
    inputName: metadata.input_name || defaults.inputName,
    outputNames: {
      masks: metadata.output_names?.masks || 'output1',
    },
    stride,
  };
}

/**
 * Discover available models by fetching metadata from all model paths.
 * Populates the provided map with discovered models.
 */
export async function discoverModels(
  modelPaths: string[],
  availableModels: Map<string, ModelDefinition>,
): Promise<void> {
  if (availableModels.size > 0) {
    return; // Already discovered
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

  logger
    .withTag('modelLoader')
    .info(`Discovered ${availableModels.size} models: ${[...availableModels.keys()].join(', ')}`);
}
