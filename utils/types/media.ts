// =============================================================================
// Media Metadata Types (for inference task discrimination)
// =============================================================================

export interface IImageMetadata {
  kind: 'image';
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
  cacheControl: string | null;
  etag: string | null;
  expires: string | null;
}

export interface IFrameMetadata {
  kind: 'frame';
  videoUrl: string; // Original video source URL (for DOM matching)
  frameIndex: number; // -1 for thumbnail, 0+ for playback frames
  sessionId: string; // Unique playback session identifier
  timestampSec: number; // Position in video (seconds)
}

// Union type for inference task metadata discrimination
export type IMediaMetadata = IImageMetadata | IFrameMetadata;

export interface IImageWithMetadata {
  src: string;
  width: number;
  height: number;
  metadata: IImageMetadata;
  [key: string]: string | number | IImageMetadata;
}

// =============================================================================
// Image Transfer Payloads
// =============================================================================
// Architecture:
// - Chrome: 'bitmap' primary (MessageChannel zero-copy), 'url' fallback
// - Firefox: 'blob' primary (structured clone), 'url' fallback

interface IImageTransferBase {
  src: string;
  width: number;
  height: number;
  metadata: IImageMetadata;
  hostname: string;
}

// Chrome primary: ImageBitmap via MessageChannel (zero-copy transfer)
export interface IImageWithBitmap extends IImageTransferBase {
  kind: 'bitmap';
  bitmap: ImageBitmap;
}

// Firefox primary: Blob via browser.runtime (structured clone)
export interface IImageWithBlob extends IImageTransferBase {
  kind: 'blob';
  blob: Blob;
}

// Fallback for both browsers: URL-only, background fetches from cache
export interface IImageWithUrl extends IImageTransferBase {
  kind: 'url';
}

// Union type for cross-browser image transfer
export type IImageTransfer = IImageWithBitmap | IImageWithBlob | IImageWithUrl;

// =============================================================================
// Video Frame Transfer Payloads
// =============================================================================
// Architecture (no URL fallback - frames are generated in content, not fetchable):
// - Chrome: 'bitmap' only (MessageChannel zero-copy), throws if unavailable
// - Firefox: 'blob' only (structured clone with WebP compression)

interface IVideoFrameTransferBase {
  videoUrl: string; // Original video URL (for DOM matching)
  frameIndex: number; // -1 for thumbnail, 0+ for playback frames
  timestampSec: number; // Frame position in video (seconds)
  width: number; // Transferred frame width (may be resized)
  height: number; // Transferred frame height (may be resized)
  originalWidth: number; // Original video width (for prediction mapping)
  originalHeight: number; // Original video height (for prediction mapping)
  hostname: string;
  sessionId: string; // Unique playback session identifier
}

// Chrome only: ImageBitmap via MessageChannel (zero-copy transfer)
export interface IVideoFrameWithBitmap extends IVideoFrameTransferBase {
  kind: 'bitmap';
  bitmap: ImageBitmap;
}

// Firefox only: Compressed WebP blob via browser.runtime (structured clone)
export interface IVideoFrameWithBlob extends IVideoFrameTransferBase {
  kind: 'blob';
  blob: Blob;
}

// Union type for cross-browser video frame transfer
export type IVideoFrameTransfer = IVideoFrameWithBitmap | IVideoFrameWithBlob;
