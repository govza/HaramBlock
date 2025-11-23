import { defineProxy } from 'comctx';

import { BackgroundRpc } from '@/utils/messaging/services/backgroundRpc';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { IconService } from '@/entrypoints/background/services/iconService';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';

export { BackgroundRpc } from '@/utils/messaging/services/backgroundRpc';
export { ProvideAdapter, InjectAdapter } from '@/utils/messaging/adapters/browserRuntimeAdapter';
export type { MessageMeta } from '@/utils/messaging/adapters/browserRuntimeAdapter';

/**
 * Proxy definition for BackgroundRpc service
 * - provideBackgroundRpc: Used in background to expose the service (pass services as args)
 * - injectBackgroundRpc: Used in content scripts and popup to consume the service
 */
export const [provideBackgroundRpc, injectBackgroundRpc] = defineProxy(
  (
    hostSettingsService: HostSettingsService,
    imageCacheService: ImageCacheService,
    inferenceService: InferenceOrchestrationService,
    iconService: IconService,
  ) => new BackgroundRpc(hostSettingsService, imageCacheService, inferenceService, iconService),
  { namespace: '__haramblock__' },
);
