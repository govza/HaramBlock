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

// Base interface for image transfer payloads
interface IImageTransferBase {
  src: string;
  width: number;
  height: number;
  metadata: IImageMetadata;
  hostname: string;
}

// Chrome: Uses ImageBitmap via MessageChannel (zero-copy transfer)
export interface IImageWithBitmap extends IImageTransferBase {
  kind: 'bitmap';
  bitmap: ImageBitmap;
}

// Firefox: Uses Blob via browser.runtime (structured clone)
export interface IImageWithBlob extends IImageTransferBase {
  kind: 'blob';
  blob: Blob;
}

// URL-only: Background fetches image (uses browser cache)
export interface IImageWithUrl extends IImageTransferBase {
  kind: 'url';
}

// Union type for cross-browser image transfer
export type IImageTransfer = IImageWithBitmap | IImageWithBlob | IImageWithUrl;
