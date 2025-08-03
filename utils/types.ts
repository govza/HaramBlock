export type HostPolicy = 'whitelist' | 'blacklist' | 'process';
export type MaskType = 'blur' | 'pixelate';
export type OutlineType = 'bbox' | 'segment';

export interface IHostSettings {
  hostname: string;
  isGlobal: boolean;
  masks: MaskType[];
  outline: OutlineType;
  policy: HostPolicy;
  strictness: number;
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
  polygon: Array<{ x: number; y: number }>;
}

export interface IImageMetadata {
  contentType?: string;
  contentLength?: number;
  lastModified?: string;
  cacheControl?: string;
  etag?: string;
  expires?: string;
  [key: string]: string | number | undefined;
}

export interface IImageWithMetadata {
  src: string;
  metadata?: IImageMetadata;
  [key: string]: string | IImageMetadata | undefined;
}

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

export interface IImagePrediction {
  hostname: string;
  src: string;
  imageWidth: number;
  imageHeight: number;
  predictions: IElementPrediction[];
  timestamp: number; // When the prediction was made
  cacheMetadata: ICacheMetadata; // HTTP cache and metadata information
}

export interface YamlMetadata {
  names: { [key: number]: string };
  stride: number;
  imgsz: [number, number];

  description?: string;
  author?: string;
  date?: string;
  version?: string;
  license?: string;
  docs?: string;
  batch?: number;

  args?: {
    batch: number;
    half: boolean;
    int8: boolean;
    nms: boolean;
  };
}

export interface Metadata extends YamlMetadata {
  outputShape: [number, number, number];
  namesToCheck: string[];
}
