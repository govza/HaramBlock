import { logger, extractUrlId } from '@/utils/logger';
import { backgroundRpc } from '@/utils/messaging/content';
import { type IImagePrediction } from '@/utils/types';

/**
 * Communication listener module for HaramBlock content script
 * Handles subscription callbacks from background via RPC
 *
 * Uses a flag-based pattern to handle cleanup:
 * - Immediately stops callback execution when unsubscribed
 * - Cleans up background subscription when the promise resolves
 */

type HostSettingsUpdateMessage = { hostname: string };
type InferenceImagePredictionsMessage = { predictions: IImagePrediction[]; hostname: string };

/**
 * Listen for host settings updates from background script
 * @param callback - Function to call when settings are updated
 * @returns Cleanup function to stop receiving updates
 */
export function onHostSettingsUpdated(callback: (data: HostSettingsUpdateMessage) => void): () => void {
  let isActive = true;
  let subscriptionId: string | null = null;

  // Subscribe - comctx wraps the callback and returns subscription ID as Promise
  void (
    backgroundRpc.onHostSettingsUpdated(hostname => {
      if (isActive) {
        callback({ hostname });
      }
    }) as unknown as Promise<string>
  )
    .then(id => {
      subscriptionId = id;
      // If already unsubscribed while waiting, clean up now
      if (!isActive) {
        void backgroundRpc.offHostSettingsUpdated(id);
      }
    })
    .catch(error => {
      logger.withTag('listener').error('Failed to subscribe to host settings updates:', error);
    });

  return () => {
    isActive = false;
    if (subscriptionId) {
      void backgroundRpc.offHostSettingsUpdated(subscriptionId);
    }
  };
}

/**
 * Listen for image predictions from background script
 * @param callback - Function to call when predictions are received
 * @returns Cleanup function to stop receiving predictions
 */
export function onImagePredictions(callback: (data: InferenceImagePredictionsMessage) => void): () => void {
  let isActive = true;
  let subscriptionId: string | null = null;

  // Subscribe - comctx wraps the callback and returns subscription ID as Promise
  void (
    backgroundRpc.onInferencePredictions(data => {
      if (isActive) {
        logger.withTag('listener').debug(
          'onInferencePredictions:',
          data.predictions.map(
            pred => `${extractUrlId(pred.src)} => ${pred.predictions[0]?.probability.toFixed(2) ?? 'N/A'}`,
          ),
        );
        callback(data);
      }
    }) as unknown as Promise<string>
  )
    .then(id => {
      subscriptionId = id;
      // If already unsubscribed while waiting, clean up now
      if (!isActive) {
        void backgroundRpc.offInferencePredictions(id);
      }
    })
    .catch(error => {
      logger.withTag('listener').error('Failed to subscribe to inference predictions:', error);
    });

  return () => {
    isActive = false;
    if (subscriptionId) {
      void backgroundRpc.offInferencePredictions(subscriptionId);
    }
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
