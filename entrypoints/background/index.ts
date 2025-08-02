import {
  HostSettingsController,
  IconController,
  PredictionCacheController,
  InferenceController,
} from '@/entrypoints/background/controllers';
import { IconEventListener } from '@/entrypoints/background/events';
import { HostSettingsService } from '@/entrypoints/background/services';
import { logger } from '@/utils/logger';

export default defineBackground(() => {
  // Initialize services (business logic layer)
  const hostSettingsService = new HostSettingsService();

  // Initialize event listeners (event handling layer)
  const iconEventListener = new IconEventListener();

  // Initialize controllers (message/request handling layer)
  const hostSettingsController = new HostSettingsController(
    hostSettingsService,
  );
  const iconController = new IconController();
  const predictionCacheController = new PredictionCacheController();
  const inferenceController = new InferenceController();

  // Initialize all event listeners and controllers
  iconEventListener.initialize();
  hostSettingsController.initialize();
  iconController.initialize();
  predictionCacheController.initialize();
  inferenceController.initialize();

  logger
    .withTag('background')
    .debug('Background script initialized successfull.');
});
