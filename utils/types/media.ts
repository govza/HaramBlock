// =============================================================================
// Media Metadata Types (for inference task discrimination)
// =============================================================================

/** Live delivery identity. Never use this pair as a persistent cache key. */
export interface IFrameSampleRouting {
  sessionId: string;
  frameIndex: number;
}

/** Reusable position on a video's media timeline; future cache identity starts here. */
export interface IVideoTimelinePosition {
  videoUrl: string;
  timestampSec: number;
}

/** Complete identity of one Frame Sample before pixels or a verdict are attached. */
export interface IFrameSampleIdentity extends IFrameSampleRouting, IVideoTimelinePosition {}

export interface IImageMetadata {
  kind: 'image';
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
  cacheControl: string | null;
  etag: string | null;
  expires: string | null;
}

export interface IFrameMetadata extends IFrameSampleIdentity {
  kind: 'frame';
}

export interface IGifFrameMetadata {
  kind: 'gifFrame';
  src: string; // GIF source URL (for DOM matching)
  frameIndex: number; // 0+ decoded frame index within the GIF
  frameCount: number; // Total number of decoded frames in this session
  sessionId: string; // Unique decode session identifier
}

// Union type for inference task metadata discrimination
export type IMediaMetadata = IImageMetadata | IFrameMetadata | IGifFrameMetadata;

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
  priority: number;
  traceparent?: string;
  // Timing from content script
  requestStartAt: number; // Timestamp when content script started processing (before fetch/decode)
  fetchTime?: number; // Fetch duration (content-side, may hit cache or network)
  decodeTime?: number; // Time to createImageBitmap (content-side, Chrome only)
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

interface IVideoFrameTransferBase extends IFrameSampleIdentity {
  width: number; // Transferred frame width (may be resized)
  height: number; // Transferred frame height (may be resized)
  originalWidth: number; // Original video width (for prediction mapping)
  originalHeight: number; // Original video height (for prediction mapping)
  hostname: string;
  priority: number; // Queue priority (higher = runs first)
  traceparent?: string;
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

// =============================================================================
// GIF Frame Transfer Payloads
// =============================================================================
// Animated GIF frames are decoded in the content script (ImageDecoder) and sent
// frame-by-frame, mirroring video frames. No URL fallback - frames are generated
// in content, not individually fetchable.
// - Chrome: 'bitmap' only (MessageChannel zero-copy)
// - Firefox: 'blob' only (structured clone with WebP compression)

interface IGifFrameTransferBase {
  src: string; // Original GIF URL (for DOM matching)
  frameIndex: number; // 0+ decoded frame index within the GIF
  frameCount: number; // Total number of decoded frames in this session
  sessionId: string; // Unique decode session identifier
  width: number; // Transferred frame width (may be resized)
  height: number; // Transferred frame height (may be resized)
  originalWidth: number; // Original GIF width (for prediction mapping)
  originalHeight: number; // Original GIF height (for prediction mapping)
  hostname: string;
  priority: number; // Queue priority (higher = runs first)
  traceparent?: string;
}

// Chrome only: ImageBitmap via MessageChannel (zero-copy transfer)
export interface IGifFrameWithBitmap extends IGifFrameTransferBase {
  kind: 'bitmap';
  bitmap: ImageBitmap;
}

// Firefox only: Compressed WebP blob via browser.runtime (structured clone)
export interface IGifFrameWithBlob extends IGifFrameTransferBase {
  kind: 'blob';
  blob: Blob;
}

// Union type for cross-browser GIF frame transfer
export type IGifFrameTransfer = IGifFrameWithBitmap | IGifFrameWithBlob;
