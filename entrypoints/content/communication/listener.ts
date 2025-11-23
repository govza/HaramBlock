import { logger, extractUrlId } from '@/utils/logger';
import { backgroundRpc } from '@/utils/messaging/content';
import { type IImagePrediction } from '@/utils/types';

/**
 * Communication listener module for HaramBlock content script
 * Handles subscription callbacks from background via RPC
 */

type HostSettingsUpdateMessage = { hostname: string };
type InferenceImagePredictionsMessage = { predictions: IImagePrediction[]; hostname: string };

/**
 * Listen for host settings updates from background script
 * @param callback - Function to call when settings are updated
 * @returns Cleanup function to remove the listener
 */
export function onHostSettingsUpdated(callback: (data: HostSettingsUpdateMessage) => void): () => void {
  const unsubscribe = backgroundRpc.onHostSettingsUpdated(hostname => {
    callback({ hostname });
  });

  return () => {
    unsubscribe();
  };
}

/**
 * Listen for image predictions from background script
 * @param callback - Function to call when predictions are received
 * @returns Cleanup function to remove the listener
 */
export function onImagePredictions(callback: (data: InferenceImagePredictionsMessage) => void): () => void {
  const unsubscribe = backgroundRpc.onInferencePredictions(data => {
    logger.withTag('listener').debug(
      'ON_INFERENCE_PREDICTIONS:',
      data.predictions.map(
        pred => `${extractUrlId(pred.src)} => ${pred.predictions[0]?.probability.toFixed(2) ?? 'N/A'}`,
      ),
    );
    callback(data);
  });

  return () => {
    unsubscribe();
  };
}

/**
 * Setup a filtered host settings listener that only triggers for specific hostname
 * @param targetHostname - The hostname to filter for
 * @param callback - Function to call when settings for this hostname are updated
 * @returns Cleanup function to remove the listener
 */
export function onHostSettingsUpdatedForHostname(targetHostname: string, callback: () => void): () => void {
  return onHostSettingsUpdated(data => {
    if (data.hostname === targetHostname) {
      callback();
    }
  });
}

/**
 * Helper to setup multiple listeners at once
 * @param listeners - Object containing optional listener callbacks
 * @returns Single cleanup function that removes all listeners
 */
export function setupListeners(listeners: {
  onHostSettingsUpdated?: (data: HostSettingsUpdateMessage) => void;
  onImagePredictions?: (data: InferenceImagePredictionsMessage) => void;
}): () => void {
  const cleanupFunctions: (() => void)[] = [];

  if (listeners.onHostSettingsUpdated) {
    cleanupFunctions.push(onHostSettingsUpdated(listeners.onHostSettingsUpdated));
  }

  if (listeners.onImagePredictions) {
    cleanupFunctions.push(onImagePredictions(listeners.onImagePredictions));
  }

  // Return single cleanup function that calls all individual cleanup functions
  return () => {
    cleanupFunctions.forEach(cleanup => cleanup());
  };
}
