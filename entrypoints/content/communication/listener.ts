import { DEFAULT_GLOBAL_KEY } from '@/utils/constants';
import { logger } from '@/utils/logger';
import { backgroundRpc } from '@/utils/messaging/content';
import { type IImagePrediction, type IFramePrediction } from '@/utils/types';

type HostSettingsUpdateMessage = { hostname: string };
type ImagePredictionsMessage = { predictions: IImagePrediction[]; hostname: string };
type FramePredictionsMessage = { predictions: IFramePrediction[]; hostname: string };

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

export function onImagePredictions(callback: (data: ImagePredictionsMessage) => void): () => void {
  let isActive = true;
  let subscriptionId: string | null = null;

  void (
    backgroundRpc.onImagePredictions(data => {
      if (isActive) {
        logger.withTag('listener').debug(
          'onImagePredictions:',
          data.predictions.map(pred => `${pred.src} => ${pred.predictions[0]?.probability.toFixed(2) ?? 'N/A'}`),
        );
        callback(data);
      }
    }) as unknown as Promise<string>
  )
    .then(id => {
      subscriptionId = id;
      if (!isActive) {
        void backgroundRpc.offImagePredictions(id);
      }
    })
    .catch(error => {
      logger.withTag('listener').error('Failed to subscribe to image predictions:', error);
    });

  return () => {
    isActive = false;
    if (subscriptionId) {
      void backgroundRpc.offImagePredictions(subscriptionId);
    }
  };
}

export function onFramePredictions(callback: (data: FramePredictionsMessage) => void): () => void {
  let isActive = true;
  let subscriptionId: string | null = null;

  void (
    backgroundRpc.onFramePredictions(data => {
      if (isActive) {
        logger.withTag('listener').debug(
          'onFramePredictions:',
          data.predictions.map(
            pred => `${pred.videoUrl}#${pred.frameIndex} => ${pred.predictions[0]?.probability.toFixed(2) ?? 'N/A'}`,
          ),
        );
        callback(data);
      }
    }) as unknown as Promise<string>
  )
    .then(id => {
      subscriptionId = id;
      if (!isActive) {
        void backgroundRpc.offFramePredictions(id);
      }
    })
    .catch(error => {
      logger.withTag('listener').error('Failed to subscribe to frame predictions:', error);
    });

  return () => {
    isActive = false;
    if (subscriptionId) {
      void backgroundRpc.offFramePredictions(subscriptionId);
    }
  };
}

/**
 * Setup a filtered host settings listener that triggers for specific hostname or global updates
 * @param targetHostname - The hostname to filter for
 * @param callback - Function to call when settings for this hostname (or global) are updated
 * @returns Cleanup function to remove the listener
 */
export function onHostSettingsUpdatedForHostname(targetHostname: string, callback: () => void): () => void {
  return onHostSettingsUpdated(data => {
    // Trigger for exact hostname match OR global settings update (affects all sites)
    if (data.hostname === targetHostname || data.hostname === DEFAULT_GLOBAL_KEY) {
      callback();
    }
  });
}

export function setupListeners(listeners: {
  onHostSettingsUpdated?: (data: HostSettingsUpdateMessage) => void;
  onImagePredictions?: (data: ImagePredictionsMessage) => void;
  onFramePredictions?: (data: FramePredictionsMessage) => void;
}): () => void {
  const cleanupFunctions: (() => void)[] = [];

  if (listeners.onHostSettingsUpdated) {
    cleanupFunctions.push(onHostSettingsUpdated(listeners.onHostSettingsUpdated));
  }

  if (listeners.onImagePredictions) {
    cleanupFunctions.push(onImagePredictions(listeners.onImagePredictions));
  }

  if (listeners.onFramePredictions) {
    cleanupFunctions.push(onFramePredictions(listeners.onFramePredictions));
  }

  return () => {
    cleanupFunctions.forEach(cleanup => cleanup());
  };
}
