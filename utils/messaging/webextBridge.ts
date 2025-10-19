import type {
  IHostSettings,
  IImagePrediction,
  IFramePrediction,
  IImageWithMetadata,
  IFrameWithMetadata,
  IVideo,
} from '@/utils/types';
import type { ProtocolWithReturn } from 'webext-bridge';

/**
 * Protocol for the bridge to communicate between different parts of the extension
 */
declare module 'webext-bridge' {
  export interface ProtocolMap {
    // #region Host Settings
    // GET /host-settings?hostname=X
    GET_HOST_SETTINGS: ProtocolWithReturn<{ hostname: string }, IHostSettings>;
    // Update icon state for hostname
    PUT_ICON: ProtocolWithReturn<{ hostname: string }, void>;
    // Notify content scripts of settings changes
    ON_HOST_SETTINGS_UPDATED: ProtocolWithReturn<{ hostname: string }, void>;
    // #endregion

    // #region Icon
    UPDATE_ICON: ProtocolWithReturn<{ hostname: string }, void>;
    // #endregion

    // #region Images
    // GET /images?hostname=X - Get cached predictions
    GET_HOSTNAME_IMAGE_PREDICTION_CACHE: ProtocolWithReturn<{ hostname: string }, IImagePrediction[]>;
    // POST /images - Process image
    POST_IMAGE: ProtocolWithReturn<{ hostname: string; imageData: IImageWithMetadata }, void>;
    // Notify content scripts of inference predictions
    ON_INFERENCE_PREDICTIONS: ProtocolWithReturn<{ predictions: IImagePrediction[] }, void>;
    // #endregion

    // #region Videos
    // POST /videos - Start video
    POST_VIDEO: ProtocolWithReturn<{ hostname: string; video: Extract<IVideo, { type: 'start' }> }, void>;
    // Notification: video summary ready
    ON_VIDEO_SUMMARY: ProtocolWithReturn<{ summary: Extract<IVideo, { type: 'summary' }> }, void>;
    // #endregion

    // #region Frames
    // POST /frames - Process frame
    POST_FRAME: ProtocolWithReturn<{ hostname: string; frameData: IFrameWithMetadata }, void>;
    // Notification: frame predictions ready
    ON_FRAME_PREDICTIONS: ProtocolWithReturn<{ predictions: IFramePrediction[] }, void>;
    // #endregion
  }
}
