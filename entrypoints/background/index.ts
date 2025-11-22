import {
  HostSettingsController,
  IconController,
  ImageCacheController,
  InferenceController,
  GetCurrentTabIdController,
  MessageChannelController,
} from '@/entrypoints/background/controllers';
import { IconEventListener, TabEventListener } from '@/entrypoints/background/events';
import {
  HostSettingsService,
  ImageCacheService,
  QueueService,
  InferenceOrchestrationService,
} from '@/entrypoints/background/services';
import { initializeInference } from '@/utils/inference';

export default defineBackground({
  type: 'module',
  main() {
    // Initialize core services (business logic layer)
    const hostSettingsService = new HostSettingsService();
    const imageCacheService = new ImageCacheService();
    const queueService = new QueueService();
    const tabEventListener = new TabEventListener();

    const inferenceService = new InferenceOrchestrationService(queueService, imageCacheService, tabEventListener);

    // Initialize event listeners (event handling layer)
    const iconEventListener = new IconEventListener();

    // Initialize controllers (message/request handling layer)
    const hostSettingsController = new HostSettingsController(hostSettingsService);
    const iconController = new IconController();
    const imageCacheController = new ImageCacheController(imageCacheService);
    const inferenceController = new InferenceController(inferenceService, hostSettingsService);
    const getCurrentTabIdController = new GetCurrentTabIdController();
    const messageChannelController = new MessageChannelController(hostSettingsService, inferenceService);

    // Initialize all event listeners and controllers
    iconEventListener.initialize();
    tabEventListener.initialize();
    hostSettingsController.initialize();
    iconController.initialize();
    imageCacheController.initialize();
    inferenceController.initialize();
    getCurrentTabIdController.initialize();
    messageChannelController.initialize();

    // Initialize inference library
    void initializeInference();
  },
});
