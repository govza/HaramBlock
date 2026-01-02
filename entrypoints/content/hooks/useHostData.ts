import { onHostSettingsUpdatedForHostname } from '@/entrypoints/content/communication/listener';
import { requestHostData } from '@/entrypoints/content/communication/sender';
import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { logger, extractUrlId } from '@/utils/logger';
import { type IHostSettings, type IImagePrediction } from '@/utils/types';

/**
 * Unified content script hook for managing both host settings and cached predictions
 * Provides a clean API for getting and managing all host-specific initialization data
 */
export async function useHostData(
  onDataUpdate?: (data: { settings: IHostSettings; predictions: IImagePrediction[] }) => void,
): Promise<{
  settings: IHostSettings;
  predictions: IImagePrediction[];
  isLoading: () => boolean;
  refresh: () => Promise<void>;
  cleanup: () => void;
}> {
  const { hostname } = globalThis.location;
  const effectiveHostname = getEffectiveHostname(hostname);
  let settings: IHostSettings = { ...DEFAULT_HOST_SETTINGS, hostname: effectiveHostname, isGlobal: false };
  let predictions: IImagePrediction[] = [];
  let isLoading = true;

  // Function to fetch both settings and predictions from background
  const fetchData = async (): Promise<{
    settings: IHostSettings;
    predictions: IImagePrediction[];
  }> => {
    const hostData = await requestHostData(effectiveHostname);
    logger.withTag('useHostData').debug(
      'Fetched data: host settings: ',
      hostData.settings,
      'cached predictions: ',
      hostData.predictions.map(pred => extractUrlId(pred.src)),
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

    // Call the update callback if provided
    if (onDataUpdate) {
      onDataUpdate({ settings, predictions });
    }
  };

  // Fetch initial data
  await refresh();

  // This triggers for both hostname-specific AND global settings changes
  const unsubscribe = onHostSettingsUpdatedForHostname(effectiveHostname, () => {
    // Only reload if settings actually changed for this hostname
    globalThis.setTimeout(() => {
      void fetchData().then(newData => {
        if (JSON.stringify(newData.settings) !== JSON.stringify(settings)) {
          globalThis.location.reload();
        }
      });
    }, 500);
  });

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
