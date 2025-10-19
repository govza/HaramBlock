import type { IHostSettings, IImagePrediction, IImageWithMetadata } from '@/utils/types';
import type { ProtocolWithReturn } from 'webext-bridge';

/**
 * Protocol for the bridge to communicate between different parts of the extension
 */
declare module 'webext-bridge' {
  export interface ProtocolMap {
    // Retrieve host settings (uses IndexedDB)
    GET_HOST_SETTINGS: ProtocolWithReturn<{ hostname: string }, IHostSettings>;

    // Update icon state for hostname
    PUT_ICON: ProtocolWithReturn<{ hostname: string }, void>;

    // Retrieve cached image predictions for a given hostname
    GET_HOSTNAME_IMAGE_PREDICTION_CACHE: ProtocolWithReturn<{ hostname: string }, IImagePrediction[]>;

    // Post image to AI model for processing
    POST_INFERENCE_IMAGES: ProtocolWithReturn<{ hostname: string; imageData: IImageWithMetadata }, void>;

    // Events FROM background (ON_ prefix for listeners)
    // Notify content scripts of settings changes
    ON_HOST_SETTINGS_UPDATED: ProtocolWithReturn<{ hostname: string }, void>;

    // Notify content scripts of inference predictions
    ON_INFERENCE_PREDICTIONS: ProtocolWithReturn<{ predictions: IImagePrediction[] }, void>;
  }
}
