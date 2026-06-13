import { getAvailableModels } from '@inference-runtime';

import { ContextMenuListener, initHostSettingsObserver, IconEventListener } from '@/entrypoints/background/events';
import {
  HostSettingsService,
  ImageCacheService,
  ModelService,
  QueueService,
  InferenceOrchestrationService,
  IconService,
} from '@/entrypoints/background/services';
import { initializeInference } from '@/utils/inference';
import { logger } from '@/utils/logger';
import { CompositeProvideAdapter, provideBackgroundRpc } from '@/utils/messaging';
import { getModelSettings, setModelSettings } from '@/utils/modelSettings';

// First-run default when WebGPU is available; without it the registry baseline (sem-i320) loads.
const WEBGPU_DEFAULT_MODEL_ID = 'sem-i448';

export default defineBackground({
  type: 'module',
  main() {
    // Initialize core services (business logic layer)
    const hostSettingsService = new HostSettingsService();
    const imageCacheService = new ImageCacheService();
    const iconService = new IconService();
    const modelService = new ModelService();
    const queueService = new QueueService();

    const inferenceService = new InferenceOrchestrationService(queueService, imageCacheService);

    // Initialize event listeners (event handling layer)
    const contextMenuListener = new ContextMenuListener();
    const iconEventListener = new IconEventListener();

    // Initialize and provide BackgroundRpc via comctx
    // Uses CompositeProvideAdapter to handle both browser.runtime and MessageChannel transports
    logger.withTag('background').log('Initializing BackgroundRpc with CompositeProvideAdapter...');
    const backgroundRpc = provideBackgroundRpc(
      new CompositeProvideAdapter(),
      hostSettingsService,
      imageCacheService,
      inferenceService,
      iconService,
      modelService,
    );
    logger.withTag('background').log('BackgroundRpc initialized successfully');

    // Wire up inference service to emit predictions via BackgroundRpc
    inferenceService.setOnImagePredictionsCallback((predictions, hostname) => {
      backgroundRpc.emitImagePredictions(predictions, hostname);
    });
    inferenceService.setOnFramePredictionsCallback((predictions, hostname) => {
      backgroundRpc.emitFramePredictions(predictions, hostname);
    });

    // Initialize all event listeners
    contextMenuListener.initialize((src, forcedVisibility) => {
      backgroundRpc.emitContextMenuToggle(src, forcedVisibility);
    });
    iconEventListener.initialize();

    // Initialize hostSettings observer to react to database changes
    initHostSettingsObserver(() => {
      void iconService.updateIconForActiveTab();
    });

    // Initialize inference with the stored model, or a sensible first-run default: WebGPU can run
    // the larger 448 comfortably, while WASM stays on the 320 baseline (448 is ~110ms on WASM).
    void (async () => {
      const { preference } = await getModelSettings();
      const preferredModelId = preference ?? ('gpu' in navigator ? WEBGPU_DEFAULT_MODEL_ID : undefined);

      try {
        await initializeInference(preferredModelId);
      } catch (error) {
        if (!preferredModelId) {
          throw error;
        }

        // The model failed to load. initializeModel rolls currentModelId back to the default on
        // failure, so the no-arg call falls back to a model that loads. Only forget a stored choice
        // when it's genuinely gone from the registry - a transient failure shouldn't discard it.
        const stillAvailable = getAvailableModels().some(m => m.id === preferredModelId);
        logger
          .withTag('background')
          .warn(
            `Model '${preferredModelId}' failed to load${
              stillAvailable ? '' : ' (no longer available)'
            }, falling back to default`,
            error,
          );
        if (!stillAvailable) {
          await setModelSettings({ preference: undefined });
        }
        await initializeInference();
      }
    })().catch(error => {
      logger.withTag('background').error('Failed to initialize inference:', error);
    });
  },
});
