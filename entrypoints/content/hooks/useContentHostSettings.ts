import { sendMessage, onMessage } from "webext-bridge/content-script";
import { getEffectiveHostname } from '@/utils/db/hostnameUtil';
import { IHostSettings } from '@/utils/db/hostSettings';

/**
 * Content script hook for managing host settings
 * Provides a clean API for getting and managing host settings in content scripts
 */
export async function useContentHostSettings(onSettingsUpdate?: (settings: IHostSettings) => void): Promise<{
  settings: IHostSettings | undefined;
  isLoading: () => boolean;
  refresh: () => Promise<void>;
  cleanup: () => void;
}> {
  const hostname = window.location.hostname;
  let settings: IHostSettings | undefined;
  let isLoading = true;
  const effectiveHostname = getEffectiveHostname(hostname);
  let messageCleanup: (() => void) | undefined;

  // Function to fetch settings from background
  const fetchSettings = async (): Promise<IHostSettings | undefined> => {
    try {
      const hostSettings = await sendMessage('GET_HOST_SETTINGS', hostname, 'background');
      return hostSettings;
    } catch (error) {
      console.error('Error fetching host settings:', error);
      return undefined;
    }
  };

  // Function to refresh settings
  const refresh = async (): Promise<void> => {
    isLoading = true;
    settings = await fetchSettings();
    isLoading = false;
    
    // Call the update callback if provided and settings are available
    if (onSettingsUpdate && settings) {
      onSettingsUpdate(settings);
    }
  };

  // Fetch initial settings
  await refresh();

  // Setup listener for settings updates
  const unsubscribe = onMessage('HOST_SETTINGS_UPDATED', async (message) => {
    const { hostname: updatedHostname } = message.data;
    
    // Check if this message is for our hostname
    if (getEffectiveHostname(updatedHostname) === effectiveHostname) {
      await refresh();
    }
  });

  messageCleanup = unsubscribe;

  return {
    settings,
    isLoading: () => isLoading,
    refresh,
    cleanup: () => {
      if (messageCleanup) {
        messageCleanup();
      }
    }
  };
}
