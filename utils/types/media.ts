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
