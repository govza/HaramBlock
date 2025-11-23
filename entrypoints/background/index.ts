import { MessageChannelController } from '@/entrypoints/background/controllers';
import { IconEventListener, TabEventListener } from '@/entrypoints/background/events';
import {
  HostSettingsService,
  ImageCacheService,
  QueueService,
  InferenceOrchestrationService,
  IconService,
} from '@/entrypoints/background/services';
import { initializeInference } from '@/utils/inference';
import { logger } from '@/utils/logger';
import { ProvideAdapter, provideBackgroundRpc } from '@/utils/messaging';

export default defineBackground({
  type: 'module',
  main() {
    // Initialize core services (business logic layer)
    const hostSettingsService = new HostSettingsService();
    const imageCacheService = new ImageCacheService();
    const iconService = new IconService();
    const queueService = new QueueService();
    const tabEventListener = new TabEventListener();

    const inferenceService = new InferenceOrchestrationService(queueService, imageCacheService, tabEventListener);

    // Initialize event listeners (event handling layer)
    const iconEventListener = new IconEventListener();

    // Initialize and provide BackgroundRpc via comctx (replaces controllers)
    logger.withTag('background').log('Initializing BackgroundRpc...');
    const backgroundRpc = provideBackgroundRpc(
      new ProvideAdapter(),
      hostSettingsService,
      imageCacheService,
      inferenceService,
      iconService,
    );
    logger.withTag('background').log('BackgroundRpc initialized successfully');

    // Wire up inference service to emit predictions via BackgroundRpc
    inferenceService.setOnPredictionsCallback((predictions, hostname) => {
      backgroundRpc.emitInferencePredictions(predictions, hostname);
    });

    // MessageChannel controller for transferables (kept separate from comctx)
    const messageChannelController = new MessageChannelController(hostSettingsService, inferenceService);

    // Initialize all event listeners and controllers
    iconEventListener.initialize();
    tabEventListener.initialize();
    messageChannelController.initialize();

    // Initialize inference library
    void initializeInference();
  },
});
