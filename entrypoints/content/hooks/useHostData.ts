import { requestHostData } from '@/entrypoints/content/communication/sender';
import { DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { getEffectiveHostname } from '@/utils/hostnameUtil';
import { logger } from '@/utils/logger';
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

  const fetchData = async (): Promise<{
    settings: IHostSettings;
    predictions: IImagePrediction[];
  }> => {
    const hostData = await requestHostData(effectiveHostname);
    logger.withTag('useHostData').debug(
      'Fetched data: host settings: ',
      hostData.settings,
      'cached predictions: ',
      hostData.predictions.map(pred => pred.src),
    );
    return hostData;
  };

  const refresh = async (): Promise<void> => {
    isLoading = true;
    const data = await fetchData();
    ({ settings } = data);
    ({ predictions } = data);
    isLoading = false;

    if (onDataUpdate) {
      onDataUpdate({ settings, predictions });
    }
  };

  await refresh();

  return {
    settings,
    predictions,
    isLoading: () => isLoading,
    refresh,
    cleanup: () => {},
  };
}
