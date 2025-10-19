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
  masks: number[][];
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
  width: number; // Media width
  height: number; // Media height
  src: string; // URL of the media image
  predictions: IElementPrediction[];
  timestamp: number; // When the prediction was made
  cacheMetadata: ICacheMetadata;
  maskTransform: IMaskTransform; // Cached letterboxing parameters for mask overlays
  processingTime: {
    fetchTime: number; // Image fetching duration in milliseconds
    bitmapTime: number; // Bitmap creation duration in milliseconds
    inferenceTime: number; // Model inference duration in milliseconds
  };
}

export interface IFramePrediction {
  sessionId: string; // Stable ID to group frames for the same <video>
  hostname: string; // Effective hostname
  width: number; // Frame media width
  height: number; // Frame media height
  frameIndex: number; // Frame number in the video
  videoUrl: string; // Original video source URL (used for DOM element matching)
  src: string; // URL of the media blob image
  predictions: IElementPrediction[];
  timestamp: number; // When the prediction was made
  cacheMetadata: ICacheMetadata;
  maskTransform: IMaskTransform; // Cached letterboxing parameters for mask overlays
  processingTime: {
    fetchTime: number; // Frame extraction duration in milliseconds
    bitmapTime: number; // Bitmap creation duration in milliseconds
    inferenceTime: number; // Model inference duration in milliseconds
  };
}
