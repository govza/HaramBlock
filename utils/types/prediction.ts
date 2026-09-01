import type { IRLEMask } from '@/utils/rle';
import type { IFrameSampleRouting, IVideoTimelinePosition } from '@/utils/types/media';

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
    inferenceTime: number; // Per-image share of the batch's preprocess + inference time in ms
    e2eTime: number; // End-to-end time from content request start to inference completion
    backend: string; // Inference backend used (webgpu/wasm)
    batchSize?: number; // Number of images in the batched session.run this image was part of
  };
  forcedVisibility: ForcedVisibility;
}

export type ForcedVisibility = 'auto' | 'visible' | 'blocked';

/**
 * Outcome of one image inference request, broadcast to content scripts.
 * Only the 'ok' arm carries a cacheable prediction; 'error' feeds the content
 * script's retry counter instead of leaving the image stuck behind the
 * inference watchdog. The tag is a literal union so it can grow (e.g. a
 * future 'skipped').
 */
export type ImageInferenceResult =
  | { status: 'ok'; prediction: IImagePrediction; traceparent?: string }
  | { status: 'error'; src: string; hostname: string; reason?: string; traceparent?: string };

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

/**
 * Verdict data reusable on the same video timeline. Unlike IFramePrediction,
 * it has no VideoSession routing identity and is suitable for a future cache
 * once media revision and model identity are added to its key.
 */
export interface IVideoFrameVerdict extends IVideoTimelinePosition {
  width: number; // Frame media width
  height: number; // Frame media height
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

/** A reusable timeline verdict rebound to the VideoSession that requested it. */
export interface IFramePrediction extends IFrameSampleRouting, IVideoFrameVerdict {
  hostname: string; // Effective hostname
  src: string; // URL of the media blob image
}

export interface IGifFramePrediction {
  sessionId: string; // Stable ID grouping decoded frames of one GIF decode
  hostname: string; // Effective hostname
  src: string; // Original GIF source URL (used for DOM element matching)
  frameIndex: number; // Sampled frame index within the GIF
  frameCount: number; // Total number of decoded frames in this session
  width: number; // Frame width
  height: number; // Frame height
  predictions: IElementPrediction[];
  maskTransform: IMaskTransform; // Cached letterboxing parameters for mask overlays
  timestamp: number; // When the prediction was made
}

/**
 * Outcome of one video frame inference request. An 'error' frees the session's
 * in-flight sample slot immediately (via the machine's transient sendFailed
 * arm) instead of waiting out the sample timeout.
 */
export type FrameInferenceResult =
  | { status: 'ok'; prediction: IFramePrediction; traceparent?: string }
  | { status: 'error'; hostname: string; sessionId: string; frameIndex: number; reason?: string; traceparent?: string };

/**
 * Outcome of one GIF frame inference request. An 'error' counts toward the
 * session's failed-frame tally so the GIF finalizes (fail closed) as soon as
 * every sampled frame is accounted for, instead of waiting out the verdict
 * timeout.
 */
export type GifFrameInferenceResult =
  | { status: 'ok'; prediction: IGifFramePrediction; traceparent?: string }
  | { status: 'error'; hostname: string; src: string; sessionId: string; reason?: string; traceparent?: string };

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
