import { switchModel } from '@inference-runtime';

import { initHostSettingsObserver, IconEventListener } from '@/entrypoints/background/events';
import {
  HostSettingsService,
  ImageCacheService,
  QueueService,
  InferenceOrchestrationService,
  IconService,
} from '@/entrypoints/background/services';
import { AutoModelService } from '@/entrypoints/background/services/autoModelService';
import { initializeInference } from '@/utils/inference';
import { logger } from '@/utils/logger';
import { CompositeProvideAdapter, provideBackgroundRpc } from '@/utils/messaging';
import { getModelSettings } from '@/utils/modelSettings';

export default defineBackground({
  type: 'module',
  main() {
    // Initialize core services (business logic layer)
    const hostSettingsService = new HostSettingsService();
    const imageCacheService = new ImageCacheService();
    const iconService = new IconService();
    const queueService = new QueueService();

    const inferenceService = new InferenceOrchestrationService(queueService, imageCacheService);

    // Initialize event listeners (event handling layer)
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
    iconEventListener.initialize();

    // Initialize hostSettings observer to react to database changes
    initHostSettingsObserver(hostname => {
      backgroundRpc.emitHostSettingsUpdated(hostname);
      void iconService.updateIconForActiveTab();
    });

    // Initialize inference library, apply stored preference, then auto model service
    void initializeInference().then(async () => {
      const settings = await getModelSettings();
      if (settings.preference !== 'auto') {
        await switchModel(settings.preference);
      }
      await autoModelService.initialize();
    });
  },
});
