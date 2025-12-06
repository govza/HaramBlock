import type { IHostSettings } from '@/utils/types/host';
import type { IMediaMetadata } from '@/utils/types/media';

export interface InferenceTask {
  imageSrc: string;
  hostname: string;
  priority: number;
  createdAt: Date;
  tabId: number;
  hostSettings: IHostSettings;
  mediaMetadata: IMediaMetadata;
  /** Optional pre-loaded bitmap (from MessageChannel transferable) */
  bitmap?: ImageBitmap;
  /** Optional blob (from Firefox structured clone) - converted to bitmap by inference library */
  blob?: Blob;
  /** Original image dimensions (when bitmap or blob is provided) */
  originalWidth?: number;
  originalHeight?: number;
}

export enum ProcessingStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Represents the coordinate transformation parameters for converting model coordinates to image coordinates.
 */
export interface CoordinateTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Represents raw detection data from the ML model.
 */
export interface RawDetection {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  score: number;
  classId: number;
  className: string;
}

/**
 * Raw detection data extracted from model detection tensor.
 * Corresponds to pred[:, :4] (bounding boxes), pred[:, 4:6] (score, class), and pred[:, 6:] (segmentation coefficients).
 */
export interface ModelDetection {
  /** Bounding box coordinates in model space */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Detection confidence score */
  score: number;
  /** Class label as float (needs Math.floor for integer class ID) */
  classLabel: number;
  /** Segmentation coefficients for mask generation (corresponds to pred[:, 6:]) */
  segmentationCoefficients: number[];
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
