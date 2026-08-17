import { defineProxy } from 'comctx';

import { USE_MESSAGE_CHANNEL } from '@/utils/constants';
import { BackgroundRpc } from '@/utils/messaging/services/backgroundRpc';

import type { HostSettingsService } from '@/entrypoints/background/services/hostSettingsService';
import type { IconService } from '@/entrypoints/background/services/iconService';
import type { ImageCacheService } from '@/entrypoints/background/services/imageCacheService';
import type { InferenceOrchestrationService } from '@/entrypoints/background/services/inferenceOrchestrationService';
import type { MediaFetchService } from '@/entrypoints/background/services/mediaFetchService';
import type { ModelService } from '@/entrypoints/background/services/modelService';

export { BackgroundRpc } from '@/utils/messaging/services/backgroundRpc';
export { ProvideAdapter, InjectAdapter } from '@/utils/messaging/adapters/browserRuntimeAdapter';
export { MessageChannelInjectAdapter } from '@/utils/messaging/adapters/messageChannelAdapter';
export { MessageChannelProvideAdapter } from '@/utils/messaging/adapters/messageChannelProvideAdapter';
export { CompositeProvideAdapter } from '@/utils/messaging/adapters/compositeProvideAdapter';
export { HybridInjectAdapter } from '@/utils/messaging/adapters/hybridInjectAdapter';
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
    modelService: ModelService,
    mediaFetchService: MediaFetchService,
  ) =>
    new BackgroundRpc(
      hostSettingsService,
      imageCacheService,
      inferenceService,
      iconService,
      modelService,
      mediaFetchService,
    ),
  {
    namespace: '__haramblock__',
    // Chrome: Enable transferable extraction for MessageChannel (zero-copy ImageBitmap)
    // Firefox: Disable - use structured clone which handles ImageBitmap natively
    transfer: USE_MESSAGE_CHANNEL,
    // Increase timeout to handle slow service worker wake-up + model initialization
    heartbeatTimeout: 25000,
  },
);
