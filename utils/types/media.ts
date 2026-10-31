/**
 * Live delivery identity. Never use this pair as a persistent cache key.
 */
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

/**
 * Complete identity of one Frame Sample before pixels or a verdict are attached.
 */
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
  src: string;
  frameIndex: number;
  frameCount: number;
  sessionId: string;
}

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
  requestStartAt: number;
  fetchTime?: number;
  decodeTime?: number;
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

export type IImageTransfer = IImageWithBitmap | IImageWithBlob | IImageWithUrl;

/**
 * Fields common to every video Frame Sample sent for inference; frames are generated in content, so there is no URL
 * fallback.
 */
interface IVideoFrameTransferBase extends IFrameSampleIdentity {
  sampleKind: FrameSampleKind;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  hostname: string;
  priority: number;
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

export type IVideoFrameTransfer = IVideoFrameWithBitmap | IVideoFrameWithBlob;

/**
 * Fields common to every decoded animated-GIF frame sent for inference; frames are generated in content, so there is no
 * URL fallback.
 */
interface IGifFrameTransferBase {
  src: string;
  frameIndex: number;
  frameCount: number;
  sessionId: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  hostname: string;
  priority: number;
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

export type IGifFrameTransfer = IGifFrameWithBitmap | IGifFrameWithBlob;
