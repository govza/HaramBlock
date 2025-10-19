import { onMessage } from 'webext-bridge/content-script';

import { logger, extractUrlId } from '@/utils/logger';
import { type IImagePrediction, type IFramePrediction } from '@/utils/types';

/**
 * Communication listener module for HaramBlock content script
 * Handles all inbound webext-bridge messages from background script
 */

/**
 * Listen for host settings updates from background script
 * @param callback - Function to call when settings are updated
 * @returns Cleanup function to remove the listener
 */
export function onHostSettingsUpdated(callback: (data: { hostname: string }) => void): () => void {
  return onMessage('ON_HOST_SETTINGS_UPDATED', message => {
    if (message.data) {
      callback(message.data);
    }
  });
}

/**
 * Listen for AI prediction results from background script
 * @param callback - Function to call when predictions are received
 * @returns Cleanup function to remove the listener
 */
export function onImagePredictions(callback: (data: { predictions: IImagePrediction[] }) => void): () => void {
  return onMessage('ON_IMAGE_PREDICTIONS', message => {
    if (message.data) {
      logger.withTag('listener').debug(
        'ON_IMAGE_PREDICTIONS:',
        message.data.predictions.map(
          pred => `${extractUrlId(pred.src)} => ${pred.predictions[0]?.probability.toFixed(2) ?? 'N/A'}`,
        ),
      );
      callback(message.data);
    }
  });
}

/**
 * Listen for frame predictions from background script
 */
export function onFrameInferenceResult(callback: (data: { predictions: IFramePrediction[] }) => void): () => void {
  return onMessage('ON_FRAME_PREDICTIONS', message => {
    if (message.data) {
      logger.withTag('listener').debug(
        'ON_FRAME_PREDICTIONS:',
        message.data.predictions.map(pred => `${pred.sessionId}#${pred.frameIndex}@${pred.timestamp.toFixed(2)}`),
      );
      callback(message.data);
    }
  });
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
 * Setup multiple listeners at once with a single cleanup function
 * @param listeners - Object containing listener configurations
 * @returns Single cleanup function that removes all listeners
 */
export function setupListeners(listeners: {
  onHostSettingsUpdated?: (data: { hostname: string }) => void;
  onImagePredictions?: (data: { predictions: IImagePrediction[] }) => void;
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
