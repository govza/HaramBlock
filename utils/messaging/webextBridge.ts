import type { IHostSettings, IImagePrediction, IImageWithMetadata } from '@/utils/types';
import type { ProtocolWithReturn } from 'webext-bridge';

/**
 * Protocol for the bridge to communicate between different parts of the extension
 */
declare module 'webext-bridge' {
  export interface ProtocolMap {
    // Retrieve host settings (uses IndexedDB)
    GET_HOST_SETTINGS: ProtocolWithReturn<{ hostname: string }, IHostSettings>;

    // Update icon for hostname
    UPDATE_ICON: ProtocolWithReturn<{ hostname: string }, void>;

    // Notify content scripts of settings changes
    HOST_SETTINGS_UPDATED: ProtocolWithReturn<{ hostname: string }, void>;

    // Retrieve cached image predictions for a given hostname
    GET_HOSTNAME_IMAGE_PREDICTION_CACHE: ProtocolWithReturn<{ hostname: string }, IImagePrediction[]>;

    // Post image to AI model for processing
    POST_INFERENCE_IMAGES: ProtocolWithReturn<{ hostname: string; imageData: IImageWithMetadata }, void>;

    // Notify content scripts of inference predictions
    INFERENCE_IMAGE_PREDICTIONS: ProtocolWithReturn<{ predictions: IImagePrediction[] }, void>;
  }
}
