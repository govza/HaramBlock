export type HostPolicy = 'whitelist' | 'blacklist' | 'process';
export type MaskType = 'blur' | 'pixelate';
export type OutlineType = 'bbox' | 'segment' | 'full';

export interface IHostSettings {
  hostname: string;
  isGlobal: boolean;
  masks: MaskType[];
  outline: OutlineType;
  policy: HostPolicy;
  strictness: number;
  minSize: { width: number; height: number };
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

export interface IImageMetadata {
  contentType: string | null;
  contentLength: number | null;
  lastModified: string | null;
  cacheControl: string | null;
  etag: string | null;
  expires: string | null;
  [key: string]: string | number | null;
}

export interface IImageWithMetadata {
  src: string;
  width: number;
  height: number;
  metadata: IImageMetadata;
  [key: string]: string | number | IImageMetadata;
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

export interface IMaskTransform {
  imageScaleInModel: number; // How image was scaled to fit 160x160
  modelOffsetX: number; // X padding in model space
  modelOffsetY: number; // Y padding in model space
  version?: number; // Cache version for schema migrations
}

export interface IImagePrediction {
  hostname: string;
  src: string;
  imageWidth: number;
  imageHeight: number;
  predictions: IElementPrediction[];
  timestamp: number; // When the prediction was made
  cacheMetadata: ICacheMetadata; // HTTP cache and metadata information
  maskTransform: IMaskTransform; // Cached letterboxing parameters for mask overlays
  processingTime: {
    fetchTime: number; // Image fetching duration in milliseconds
    bitmapTime: number; // Bitmap creation duration in milliseconds
    inferenceTime: number; // Model inference duration in milliseconds
  };
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
