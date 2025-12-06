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
import { CompositeProvideAdapter, provideBackgroundRpc } from '@/utils/messaging';

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

    // Initialize and provide BackgroundRpc via comctx
    // Uses CompositeProvideAdapter to handle both browser.runtime and MessageChannel transports
    logger.withTag('background').log('Initializing BackgroundRpc with CompositeProvideAdapter...');
    const backgroundRpc = provideBackgroundRpc(
      new CompositeProvideAdapter(),
      hostSettingsService,
      imageCacheService,
      inferenceService,
      iconService,
      tabEventListener,
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
    iconEventListener.initialize();
    tabEventListener.initialize();

    // Initialize inference library
    void initializeInference();
  },
});
