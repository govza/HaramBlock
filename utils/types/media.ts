export interface IImageMetadata {
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
  cacheControl: string | null;
  etag: string | null;
  expires: string | null;
  [key: string]: string | number | boolean | null;
}

export interface IImageWithMetadata {
  src: string;
  width: number;
  height: number;
  metadata: IImageMetadata;
  [key: string]: string | number | IImageMetadata;
}

export interface VideoFrameLoopConfig {
  frameInterval: number;
  maxErrors: number;
  enableTemporalSmoothing: boolean;
  positiveThreshold: number;
  negativeThreshold: number;
  maxSendFps?: number;
}

// Payload for posting a video frame via bridge (fallback path)
export interface IVideoFrameWithMetadata {
  frameBlobUrl: string; // Temporary blob URL for the extracted frame image
  videoUrl: string; // Original video source URL from the DOM
  width: number;
  height: number;
  frameIndex: number;
  timestampSec: number; // Frame timestamp in seconds
  metadata: IImageMetadata; // Extended with frame info
  [key: string]: string | number | boolean | null | IImageMetadata;
}

// Image with bitmap for transferable over MessageChannel
export interface IImageWithBitmap {
  src: string;
  width: number;
  height: number;
  metadata: IImageMetadata;
  hostname: string;
  tabId: number;
  bitmap: ImageBitmap;
}
