import { logger } from '@/utils/logger';
import { backgroundRpc } from '@/utils/messaging/content';
import {
  type ForcedVisibility,
  type IImagePrediction,
  type IFramePrediction,
  type IGifFramePrediction,
} from '@/utils/types';

type ImagePredictionsMessage = { predictions: IImagePrediction[]; hostname: string };
type FramePredictionsMessage = { predictions: IFramePrediction[]; hostname: string };
type GifFramePredictionsMessage = { predictions: IGifFramePrediction[]; hostname: string };
type ContextMenuToggleMessage = { src: string; forcedVisibility: ForcedVisibility };

export function onImagePredictions(callback: (data: ImagePredictionsMessage) => void): () => void {
  let isActive = true;
  let subscriptionId: string | null = null;

  void (
    backgroundRpc.onImagePredictions(data => {
      if (isActive) {
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

export function onGifFramePredictions(callback: (data: GifFramePredictionsMessage) => void): () => void {
  let isActive = true;
  let subscriptionId: string | null = null;

  void (
    backgroundRpc.onGifFramePredictions(data => {
      if (isActive) {
        callback(data);
      }
    }) as unknown as Promise<string>
  )
    .then(id => {
      subscriptionId = id;
      if (!isActive) {
        void backgroundRpc.offGifFramePredictions(id);
      }
    })
    .catch(error => {
      logger.withTag('listener').error('Failed to subscribe to GIF frame predictions:', error);
    });

  return () => {
    isActive = false;
    if (subscriptionId) {
      void backgroundRpc.offGifFramePredictions(subscriptionId);
    }
  };
}

export function onContextMenuToggle(callback: (data: ContextMenuToggleMessage) => void): () => void {
  let isActive = true;
  let subscriptionId: string | null = null;

  void (
    backgroundRpc.onContextMenuToggle(data => {
      if (isActive) {
        callback(data);
      }
    }) as unknown as Promise<string>
  )
    .then(id => {
      subscriptionId = id;
      if (!isActive) {
        void backgroundRpc.offContextMenuToggle(id);
      }
    })
    .catch(error => {
      logger.withTag('listener').error('Failed to subscribe to context menu toggle:', error);
    });

  return () => {
    isActive = false;
    if (subscriptionId) {
      void backgroundRpc.offContextMenuToggle(subscriptionId);
    }
  };
}
