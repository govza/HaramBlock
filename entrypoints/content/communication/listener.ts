import { onMessage } from 'webext-bridge/content-script';

import { logger, extractUrlId } from '@/utils/logger';
import { type IImagePrediction } from '@/utils/types';

/**
 * Communication listener module for HaramBlock content script
 * Handles all inbound webext-bridge messages from background script
 */

export interface HostSettingsUpdateMessage {
  hostname: string;
}

export interface InferencePredictionsMessage {
  predictions: IImagePrediction[];
  hostname: string;
}

/**
 * Listen for host settings updates from background script
 * @param callback - Function to call when settings are updated
 * @returns Cleanup function to remove the listener
 */
export function onHostSettingsUpdated(callback: (data: HostSettingsUpdateMessage) => void): () => void {
  return onMessage('HOST_SETTINGS_UPDATED', message => {
    if (message.data) {
      callback(message.data as HostSettingsUpdateMessage);
    }
  });
}

/**
 * Listen for AI prediction results from background script
 * @param callback - Function to call when predictions are received
 * @returns Cleanup function to remove the listener
 */
export function onInferencePredictions(callback: (data: InferencePredictionsMessage) => void): () => void {
  return onMessage('INFERENCE_PREDICTIONS', message => {
    if (message.data) {
      logger.withTag('listener').debug(
        'INFERENCE_PREDICTIONS:',
        message.data.predictions.map(
          pred => `${extractUrlId(pred.src)} => ${pred.predictions[0]?.probability.toFixed(2) ?? 'N/A'}`,
        ),
      );
      callback(message.data as unknown as InferencePredictionsMessage);
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
 * Setup a filtered inference predictions listener for specific hostname
 * @param targetHostname - The hostname to filter for
 * @param callback - Function to call when predictions for this hostname are received
 * @returns Cleanup function to remove the listener
 */
export function onInferencePredictionsForHostname(
  targetHostname: string,
  callback: (predictions: IImagePrediction[]) => void,
): () => void {
  return onInferencePredictions(data => {
    if (data.hostname === targetHostname) {
      callback(data.predictions);
    }
  });
}

/**
 * Setup multiple listeners at once with a single cleanup function
 * @param listeners - Object containing listener configurations
 * @returns Single cleanup function that removes all listeners
 */
export function setupListeners(listeners: {
  onHostSettingsUpdated?: (data: HostSettingsUpdateMessage) => void;
  onInferencePredictions?: (data: InferencePredictionsMessage) => void;
}): () => void {
  const cleanupFunctions: (() => void)[] = [];

  if (listeners.onHostSettingsUpdated) {
    cleanupFunctions.push(onHostSettingsUpdated(listeners.onHostSettingsUpdated));
  }

  if (listeners.onInferencePredictions) {
    cleanupFunctions.push(onInferencePredictions(listeners.onInferencePredictions));
  }

  // Return single cleanup function that calls all individual cleanup functions
  return () => {
    cleanupFunctions.forEach(cleanup => cleanup());
  };
}
