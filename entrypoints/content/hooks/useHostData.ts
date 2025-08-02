import { getEffectiveHostname } from '@/utils/db/hostnameUtil';
import { IHostSettings, IImagePrediction } from '@/utils/types';
import { logger } from '@/utils/logger';
import { requestHostData } from '../communication/sender';
import { onHostSettingsUpdatedForHostname } from '../communication/listener';

/**
 * Unified content script hook for managing both host settings and cached predictions
 * Provides a clean API for getting and managing all host-specific initialization data
 */
export async function useHostData(
  onDataUpdate?: (data: { settings: IHostSettings; predictions: IImagePrediction[] }) => void
): Promise<{
  settings: IHostSettings | undefined;
  predictions: IImagePrediction[];
  isLoading: () => boolean;
  refresh: () => Promise<void>;
  cleanup: () => void;
}> {
  const hostname = window.location.hostname;
  let settings: IHostSettings | undefined;
  let predictions: IImagePrediction[] = [];
  let isLoading = true;
  const effectiveHostname = getEffectiveHostname(hostname);
  let messageCleanup: (() => void) | undefined;

  // Function to fetch both settings and predictions from background
  const fetchData = async (): Promise<{ settings: IHostSettings | undefined; predictions: IImagePrediction[] }> => {
    const hostData = await requestHostData(effectiveHostname);
    logger.withTag("useHostData")
      .debug(`Fetched data: host settings: `, hostData.settings, `cached predictions: `, hostData.predictions);
    return hostData;
  };

  // Function to refresh all data
  const refresh = async (): Promise<void> => {
    isLoading = true;
    const data = await fetchData();
    settings = data.settings;
    predictions = data.predictions;
    isLoading = false;

    // Call the update callback if provided and settings are available
    if (onDataUpdate && settings) {
      onDataUpdate({ settings, predictions });
    }
  };

  // Fetch initial data
  await refresh();

  // Setup listener for settings updates (predictions are updated via inference results)
  const unsubscribe = onHostSettingsUpdatedForHostname(effectiveHostname, async () => {
    // Refresh the page when settings change to ensure clean state
    // Small delay to ensure background script has finished processing
    setTimeout(() => {
      window.location.reload();
    }, 100);
  });

  messageCleanup = unsubscribe;

  return {
    settings,
    predictions,
    isLoading: () => isLoading,
    refresh,
    cleanup: () => {
      if (messageCleanup) {
        messageCleanup();
      }
    }
  };
}
