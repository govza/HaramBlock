import { getAvailableModels } from '@inference-runtime';

import { cacheModelIdOf } from '@/utils/inference/shared/modelRegistry';

import type { StoredModelId } from '@/utils/types';

/**
 * Every model id a cache record of this build can carry: image rows store the plain id, video sample
 * buckets the versioned one.
 */
export const shippedModelIds = (): ReadonlySet<StoredModelId> =>
  new Set(getAvailableModels().flatMap(model => [model.id, cacheModelIdOf(model)]));
