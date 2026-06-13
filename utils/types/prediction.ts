import type { IRLEMask } from '@/utils/rle';

export interface ICacheMetadata {
  // HTTP Cache headers
  cacheControl?: string; // Cache-Control header value
  etag?: string; // ETag header value
  lastModified?: number; // Last-Modified timestamp
  expires?: number; // Expires header timestamp

  // Cache management
  maxAge?: number; // Max age in seconds (from Cache-Control or computed)
  createdAt: number; // When this cache entry was created
  accessedAt: number; // Last time this cache entry was accessed

  // Image metadata
  contentType?: string; // MIME type of the image
  contentLength?: number; // Size of the image in bytes
}

export interface IElementPrediction {
  classId: number;
  className: string;
  probability: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  masks: IRLEMask;
}

// How the image was transformed to fit the model input size
export interface IMaskTransform {
  scaleX: number; // Scale factor in X direction
  scaleY: number; // Scale factor in Y direction
  offsetX: number; // Offset in X direction
  offsetY: number; // Offset in Y direction
}

export interface IImagePrediction {
  hostname: string;
  src: string;
  width: number;
  height: number;
  predictions: IElementPrediction[];
  timestamp: number; // When the prediction was made
  cacheMetadata: ICacheMetadata; // HTTP cache and metadata information
  maskTransform: IMaskTransform; // Cached letterboxing parameters for mask overlays
  processingTime: {
    fetchTime: number; // Fetch duration in milliseconds (may hit cache or network)
    decodeTime: number; // createImageBitmap duration in milliseconds
    queueTime: number; // Time waiting in queue before inference in milliseconds
    inferenceTime: number; // Model preprocessing + inference + postprocessing in milliseconds
    e2eTime: number; // End-to-end time from content request start to inference completion
    backend: string; // Inference backend used (webgpu/wasm)
  };
  forcedVisibility: ForcedVisibility;
}

export type ForcedVisibility = 'auto' | 'visible' | 'blocked';

export function shouldBlock(prediction: IImagePrediction): boolean {
  if (prediction.forcedVisibility === 'visible') return false;
  if (prediction.forcedVisibility === 'blocked') return true;
  return Boolean(prediction.predictions?.length);
}

export interface IVideoFramePrediction {
  frameIndex: number; // Frame number in the video
  timestamp: number; // Frame timestamp in seconds
  videoUrl: string; // Original video source URL (used for DOM element matching)
  predictions: IElementPrediction[]; // Object predictions for this frame
  processingTime: {
    frameExtractionTime: number; // Time to extract frame from video in milliseconds
    decodeTime: number; // createImageBitmap duration in milliseconds
    inferenceTime: number; // Model inference duration in milliseconds
  };
}

export interface IFramePrediction {
  sessionId: string; // Stable ID to group frames for the same <video>
  hostname: string; // Effective hostname
  width: number; // Frame media width
  height: number; // Frame media height
  frameIndex: number; // Frame number in the video (-1 for thumbnail)
  videoUrl: string; // Original video source URL (used for DOM element matching)
  src: string; // URL of the media blob image
  predictions: IElementPrediction[];
  timestamp: number; // When the prediction was made
  cacheMetadata: ICacheMetadata;
  maskTransform: IMaskTransform; // Cached letterboxing parameters for mask overlays
  processingTime: {
    fetchTime: number; // Fetch duration in milliseconds (may hit cache or network)
    decodeTime: number; // createImageBitmap duration in milliseconds
    queueTime: number; // Time waiting in queue before inference in milliseconds
    inferenceTime: number; // Model preprocessing + inference + postprocessing in milliseconds
    e2eTime: number; // End-to-end time from content request start to inference completion
    backend: string; // Inference backend used (webgpu/wasm)
  };
}

export interface IVideoPrediction {
  hostname: string;
  src: string; // Original video source URL
  videoWidth: number;
  videoHeight: number;
  duration: number; // Video duration in seconds
  frameRate: number; // Frames per second
  frames: IVideoFramePrediction[]; // Predictions for sampled frames
  sampleInterval: number; // Interval between sampled frames in seconds
  timestamp: number; // When the prediction was made
  cacheMetadata: ICacheMetadata; // HTTP cache and metadata information
  maskTransform: IMaskTransform; // Cached letterboxing parameters for mask overlays
  processingTime: {
    fetchTime: number; // Video metadata fetching duration in milliseconds
    totalInferenceTime: number; // Total inference time for all frames in milliseconds
  };
}
