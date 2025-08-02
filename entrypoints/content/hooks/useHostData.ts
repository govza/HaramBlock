import { onHostSettingsUpdatedForHostname } from '@/entrypoints/content/communication/listener';
import { requestHostData } from '@/entrypoints/content/communication/sender';
import { getEffectiveHostname } from '@/utils/db/hostnameUtil';
import { type IHostSettings, type IImagePrediction } from '@/utils/types';

/**
 * Unified content script hook for managing both host settings and cached predictions
 * Provides a clean API for getting and managing all host-specific initialization data
 */
export async function useHostData(
  onDataUpdate?: (data: {
    settings: IHostSettings;
    predictions: IImagePrediction[];
  }) => void,
): Promise<{
  settings: IHostSettings | undefined;
  predictions: IImagePrediction[];
  isLoading: () => boolean;
  refresh: () => Promise<void>;
  cleanup: () => void;
}> {
  const { hostname } = globalThis.location;
  let settings: IHostSettings | undefined;
  let predictions: IImagePrediction[] = [];
  let isLoading = true;
  const effectiveHostname = getEffectiveHostname(hostname);

  // Function to fetch both settings and predictions from background
  const fetchData = async (): Promise<{
    settings: IHostSettings | undefined;
    predictions: IImagePrediction[];
  }> => {
    const hostData = await requestHostData(effectiveHostname);
    logger
      .withTag('useHostData')
      .debug(
        'Fetched data: host settings: ',
        hostData.settings,
        'cached predictions: ',
        hostData.predictions,
      );
    return hostData;
  };

  // Function to refresh all data
  const refresh = async (): Promise<void> => {
    isLoading = true;
    const data = await fetchData();
    ({ settings } = data);
    ({ predictions } = data);
    isLoading = false;

    // Call the update callback if provided and settings are available
    if (onDataUpdate && settings) {
      onDataUpdate({ settings, predictions });
    }
  };

  // Fetch initial data
  await refresh();

  // Setup listener for settings updates (predictions are updated via inference results)
  const unsubscribe = onHostSettingsUpdatedForHostname(
    effectiveHostname,
    () => {
      // Refresh the page when settings change to ensure clean state
      // Small delay to ensure background script has finished processing
      globalThis.setTimeout(() => {
        globalThis.location.reload();
      }, 100);
    },
  );

  const messageCleanup = unsubscribe;

  return {
    settings,
    predictions,
    isLoading: () => isLoading,
    refresh,
    cleanup: () => {
      if (messageCleanup) {
        messageCleanup();
      }
    },
  };
}
