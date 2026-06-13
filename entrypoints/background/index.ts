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
import { AutoModelService } from '@/entrypoints/background/services/autoModelService';
import { initializeInference } from '@/utils/inference';
import { logger } from '@/utils/logger';
import { CompositeProvideAdapter, provideBackgroundRpc } from '@/utils/messaging';
import { getModelSettings, setModelSettings } from '@/utils/modelSettings';

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

    // Initialize auto model service
    const autoModelService = new AutoModelService();

    // Wire up inference service to emit predictions via BackgroundRpc
    // Also trigger auto model evaluation after predictions
    inferenceService.setOnImagePredictionsCallback((predictions, hostname) => {
      backgroundRpc.emitImagePredictions(predictions, hostname);
      void autoModelService.evaluate();
    });
    inferenceService.setOnFramePredictionsCallback((predictions, hostname) => {
      backgroundRpc.emitFramePredictions(predictions, hostname);
      void autoModelService.evaluate();
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

    // Initialize inference library with the stored model preference, then auto model service.
    void (async () => {
      const settings = await getModelSettings();
      const isAuto = settings.preference === 'auto';
      const preferredModelId = isAuto ? settings.autoSelectedModelId : settings.preference;

      try {
        await initializeInference(preferredModelId);
      } catch (error) {
        if (!preferredModelId) {
          throw error;
        }

        // The stored model failed to load. initializeModel rolls currentModelId back to the default
        // on failure, so the no-arg call falls back to a model that loads. Only forget the reference
        // when it's genuinely gone from the registry - a transient failure shouldn't discard it.
        const stillAvailable = getAvailableModels().some(m => m.id === preferredModelId);
        logger
          .withTag('background')
          .warn(
            `Stored model '${preferredModelId}' failed to load${
              stillAvailable ? '' : ' (no longer available)'
            }, falling back to default`,
            error,
          );
        if (!stillAvailable) {
          await setModelSettings(isAuto ? { autoSelectedModelId: undefined } : { preference: 'auto' });
        }
        await initializeInference();
      }

      await autoModelService.initialize();
    })().catch(error => {
      logger.withTag('background').error('Failed to initialize inference:', error);
    });
  },
});
