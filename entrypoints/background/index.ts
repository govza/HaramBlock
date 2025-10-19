import {
  HostSettingsController,
  IconController,
  ImageCacheController,
  InferenceController,
  MessageChannelController,
  GetCurrentTabIdController,
} from '@/entrypoints/background/controllers';
import { IconEventListener, TabEventListener } from '@/entrypoints/background/events';
import {
  HostSettingsService,
  ModelLoaderService,
  ImageCacheService,
  ImageProcessorService,
  PredictionService,
  QueueService,
  InferenceOrchestrationService,
} from '@/entrypoints/background/services';

export default defineBackground({
  type: 'module',
  main() {
    // Initialize core services (business logic layer)
    const hostSettingsService = new HostSettingsService();
    const modelLoaderService = new ModelLoaderService();
    const imageCacheService = new ImageCacheService();

    // Initialize new architecture services
    const imageProcessorService = new ImageProcessorService();
    const queueService = new QueueService();

    const predictionService = new PredictionService(modelLoaderService, imageProcessorService);

    const tabEventListener = new TabEventListener();

    const inferenceService = new InferenceOrchestrationService(
      queueService,
      predictionService,
      imageCacheService,
      tabEventListener,
    );

    // Initialize event listeners (event handling layer)
    const iconEventListener = new IconEventListener();

    // Initialize controllers (message/request handling layer)
    const hostSettingsController = new HostSettingsController(hostSettingsService);
    const iconController = new IconController();
    const imageCacheController = new ImageCacheController(imageCacheService);
    const inferenceController = new InferenceController(inferenceService, hostSettingsService);
    const messageChannelController = new MessageChannelController(hostSettingsService, inferenceService);
    const getCurrentTabIdController = new GetCurrentTabIdController();

    // Initialize all event listeners and controllers
    iconEventListener.initialize();
    tabEventListener.initialize();
    hostSettingsController.initialize();
    iconController.initialize();
    imageCacheController.initialize();
    inferenceController.initialize();
    messageChannelController.initialize();
    getCurrentTabIdController.initialize();

    // Initialize services
    void modelLoaderService.initialize();
  },
});
