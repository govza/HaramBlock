import {
  HostSettingsController,
  IconController,
  PredictionCacheController,
  InferenceController,
  MessageChannelController,
} from '@/entrypoints/background/controllers';
import { IconEventListener, TabEventListener } from '@/entrypoints/background/events';
import {
  HostSettingsService,
  ModelLoaderService,
  PredictionCacheService,
  ImageProcessorService,
  PredictionService,
  QueueService,
  InferenceOrchestrationService,
} from '@/entrypoints/background/services';

export default defineBackground(() => {
  // Initialize core services (business logic layer)
  const hostSettingsService = new HostSettingsService();
  const modelLoaderService = new ModelLoaderService();
  const predictionCacheService = new PredictionCacheService();

  // Initialize new architecture services
  const imageProcessorService = new ImageProcessorService();
  const queueService = new QueueService();

  const predictionService = new PredictionService(modelLoaderService, imageProcessorService);

  const tabEventListener = new TabEventListener();

  const inferenceService = new InferenceOrchestrationService(
    queueService,
    predictionService,
    predictionCacheService,
    tabEventListener,
  );

  // Initialize event listeners (event handling layer)
  const iconEventListener = new IconEventListener();

  // Initialize controllers (message/request handling layer)
  const hostSettingsController = new HostSettingsController(hostSettingsService);
  const iconController = new IconController();
  const predictionCacheController = new PredictionCacheController();
  const inferenceController = new InferenceController(inferenceService, hostSettingsService);
  const messageChannelController = new MessageChannelController(hostSettingsService, inferenceService);

  // Initialize all event listeners and controllers
  iconEventListener.initialize();
  tabEventListener.initialize();
  hostSettingsController.initialize();
  iconController.initialize();
  predictionCacheController.initialize();
  inferenceController.initialize();
  messageChannelController.initialize();

  // Initialize services
  void modelLoaderService.initialize();
});
