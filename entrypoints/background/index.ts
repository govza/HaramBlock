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
import {
  BALANCED_MODEL_ID,
  BASELINE_MODEL_ID,
  isAutoPreference,
  isBackendCapableOf,
} from '@/entrypoints/background/services/autoModelDecision';
import { AutoModelService } from '@/entrypoints/background/services/autoModelService';
import { initializeInference } from '@/utils/inference';
import { logger } from '@/utils/logger';
import { CompositeProvideAdapter, provideBackgroundRpc } from '@/utils/messaging';
import { getModelSettings, setModelSettings, updateAutoModelState, type ModelSettings } from '@/utils/modelSettings';

// Resolve which model to load at startup. A manual preference always wins. In auto mode, honor the
// remembered auto selection when this environment can run it - unlike the old auto switcher, a
// remembered sem-i320 on a WebGPU browser is a legitimate slow-GPU verdict, not forced back up to
// the balanced default. The real backend is unknown until the session exists, so WebGPU API
// availability is the proxy: with it, first-run starts at the balanced sem-i448 (~25ms on WebGPU);
// without it, the registry baseline sem-i320 loads (sem-i448 is ~110ms on WASM).
function getStartupModelId(settings: ModelSettings): string | undefined {
  if (!isAutoPreference(settings.preference)) {
    return settings.preference;
  }

  const hasWebGpu = 'gpu' in navigator;
  const remembered = settings.auto?.selectedModelId;
  if (remembered) {
    return isBackendCapableOf(remembered, hasWebGpu ? 'webgpu' : 'wasm') ? remembered : BASELINE_MODEL_ID;
  }

  return hasWebGpu ? BALANCED_MODEL_ID : undefined;
}

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

    // Reap a closed tab's subscription entries; frames that navigate away are
    // evicted when their successor re-subscribes (see BackgroundRpc.subscribe)
    browser.tabs.onRemoved.addListener(tabId => backgroundRpc.releaseTab(tabId));

    // Wire up inference service to emit predictions via BackgroundRpc
    inferenceService.setOnImagePredictionsCallback((predictions, hostname) => {
      backgroundRpc.emitImagePredictions(predictions, hostname);
    });
    inferenceService.setOnFramePredictionsCallback((predictions, hostname) => {
      backgroundRpc.emitFramePredictions(predictions, hostname);
    });
    inferenceService.setOnGifFramePredictionsCallback((predictions, hostname) => {
      backgroundRpc.emitGifFramePredictions(predictions, hostname);
    });

    // Re-size queue concurrency to the new model's batch cap on every switch.
    modelService.setOnModelSwitch(() => inferenceService.refreshConcurrency());

    // Latency-driven auto model switching (initialized after inference below).
    const autoModelService = new AutoModelService(modelService, queueService);

    // Initialize all event listeners
    contextMenuListener.initialize((src, forcedVisibility) => {
      backgroundRpc.emitContextMenuToggle(src, forcedVisibility);
    });
    iconEventListener.initialize();

    // Initialize hostSettings observer to react to database changes
    initHostSettingsObserver(() => {
      void iconService.updateIconForActiveTab();
    });

    // Initialize inference with the resolved startup model, then the auto model service.
    void (async () => {
      const settings = await getModelSettings();
      const isAuto = isAutoPreference(settings.preference);
      const preferredModelId = getStartupModelId(settings);

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
          if (isAuto) {
            await updateAutoModelState({ selectedModelId: undefined });
          } else {
            await setModelSettings({ preference: 'auto' });
          }
        }
        await initializeInference();
      }

      // Backend and model are resolved now: size concurrency to the active model's batch cap.
      inferenceService.refreshConcurrency();

      await autoModelService.initialize();
    })().catch(error => {
      logger.withTag('background').error('Failed to initialize inference:', error);
    });
  },
});
