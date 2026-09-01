import { backgroundRpc } from '@/utils/messaging/content';
import { getLogger } from '@/utils/telemetry';
import {
  type ForcedVisibility,
  type FrameInferenceResult,
  type GifFrameInferenceResult,
  type ImageInferenceResult,
} from '@/utils/types';

const log = getLogger('listener');

type ImagePredictionsMessage = { results: ImageInferenceResult[]; hostname: string };
type FramePredictionsMessage = { results: FrameInferenceResult[]; hostname: string };
type GifFramePredictionsMessage = { results: GifFrameInferenceResult[]; hostname: string };
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
      log.error('listener.subscribe.image_predictions.failed', { error });
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
      log.error('listener.subscribe.frame_predictions.failed', { error });
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
      log.error('listener.subscribe.gif_frame_predictions.failed', { error });
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
      log.error('listener.subscribe.context_menu_toggle.failed', { error });
    });

  return () => {
    isActive = false;
    if (subscriptionId) {
      void backgroundRpc.offContextMenuToggle(subscriptionId);
    }
  };
}
