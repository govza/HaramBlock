// =============================================================================
// Media Metadata Types (for inference task discrimination)
// =============================================================================

/** Live delivery identity. Never use this pair as a persistent cache key. */
export interface IFrameSampleRouting {
  sessionId: string;
  frameIndex: number;
}

/**
 * Reusable position on a video's media timeline: `mediaKey` is the video's identity key once it has a
 * stable or local one, its source URL until then.
 */
export interface IVideoTimelinePosition {
  mediaKey: string;
  sourceUrl: string;
  timestampSec: number;
}

/** Complete identity of one Frame Sample before pixels or a verdict are attached. */
export interface IFrameSampleIdentity extends IFrameSampleRouting, IVideoTimelinePosition {}

/**
 * HTTP response metadata of an image, carried with its inference request to derive the cache entry of the prediction.
 */
export interface IImageMetadata {
  kind: 'image';
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
  cacheControl: string | null;
  etag: string | null;
  expires: string | null;
}

export type FrameSampleKind = 'thumbnail' | 'live' | 'lookahead';

/**
 * Inference task metadata of a video Frame Sample: its routing, media-timeline identity and sample kind.
 */
export interface IFrameMetadata extends IFrameSampleIdentity {
  kind: 'frame';
  sampleKind: FrameSampleKind;
}

/**
 * Inference task metadata of one decoded frame of an animated GIF.
 */
export interface IGifFrameMetadata {
  kind: 'gifFrame';
  src: string; // GIF source URL (for DOM matching)
  frameIndex: number; // 0+ decoded frame index within the GIF
  frameCount: number; // Total number of decoded frames in this session
  sessionId: string; // Unique decode session identifier
}

// Union type for inference task metadata discrimination
export type IMediaMetadata = IImageMetadata | IFrameMetadata | IGifFrameMetadata;

/**
 * A discovered image with its dimensions and HTTP response metadata.
 */
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

/**
 * Fields common to every image inference request, whatever transport carries its pixels.
 */
interface IImageTransferBase {
  src: string;
  width: number;
  height: number;
  metadata: IImageMetadata;
  hostname: string;
  isIncognito: boolean;
  priority: number;
  traceparent?: string;
  // Timing from content script
  requestStartAt: number; // Timestamp when content script started processing (before fetch/decode)
  fetchTime?: number; // Fetch duration (content-side, may hit cache or network)
  decodeTime?: number; // Time to createImageBitmap (content-side, Chrome only)
}

/**
 * Chrome's primary image transfer: an ImageBitmap moved zero-copy over the MessageChannel.
 */
export interface IImageWithBitmap extends IImageTransferBase {
  kind: 'bitmap';
  bitmap: ImageBitmap;
}

/**
 * Firefox's primary image transfer: a Blob structured-cloned over `browser.runtime`.
 */
export interface IImageWithBlob extends IImageTransferBase {
  kind: 'blob';
  blob: Blob;
}

/**
 * Fallback image transfer for both browsers: the URL only, which the background fetches (usually from the HTTP cache).
 */
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

/**
 * Fields common to every video Frame Sample sent for inference; frames are generated in content, so there is no URL
 * fallback.
 */
interface IVideoFrameTransferBase extends IFrameSampleIdentity {
  sampleKind: FrameSampleKind;
  width: number; // Transferred frame width (may be resized)
  height: number; // Transferred frame height (may be resized)
  originalWidth: number; // Original video width (for prediction mapping)
  originalHeight: number; // Original video height (for prediction mapping)
  hostname: string;
  priority: number; // Queue priority (higher = runs first)
  traceparent?: string;
}

/**
 * Chrome's only video frame transfer: an ImageBitmap moved zero-copy over the MessageChannel.
 */
export interface IVideoFrameWithBitmap extends IVideoFrameTransferBase {
  kind: 'bitmap';
  bitmap: ImageBitmap;
}

/**
 * Firefox's only video frame transfer: a WebP-compressed Blob structured-cloned over `browser.runtime`.
 */
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

/**
 * Fields common to every decoded animated-GIF frame sent for inference; frames are generated in content, so there is no
 * URL fallback.
 */
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

/**
 * Chrome's only GIF frame transfer: an ImageBitmap moved zero-copy over the MessageChannel.
 */
export interface IGifFrameWithBitmap extends IGifFrameTransferBase {
  kind: 'bitmap';
  bitmap: ImageBitmap;
}

/**
 * Firefox's only GIF frame transfer: a WebP-compressed Blob structured-cloned over `browser.runtime`.
 */
export interface IGifFrameWithBlob extends IGifFrameTransferBase {
  kind: 'blob';
  blob: Blob;
}

// Union type for cross-browser GIF frame transfer
export type IGifFrameTransfer = IGifFrameWithBitmap | IGifFrameWithBlob;
