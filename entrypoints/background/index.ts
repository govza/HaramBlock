
import { IconEventListener } from '@/entrypoints/background/events';
import { HostSettingsController } from '@/entrypoints/background/controllers';
import { HostSettingsService } from '@/entrypoints/background/services';

export default defineBackground(() => {
  // Initialize services (business logic layer)
  const hostSettingsService = new HostSettingsService();

  // Initialize event listeners (event handling layer)
  const iconEventListener = new IconEventListener();

  // Initialize controllers (message/request handling layer)
  const hostSettingsController = new HostSettingsController(hostSettingsService);

  // Initialize all event listeners and controllers
  iconEventListener.initialize();
  hostSettingsController.initialize();

  console.log('Background script initialized successfully.');
});
