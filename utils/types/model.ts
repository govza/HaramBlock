import type { IHostSettings } from '@/utils/types/host';
import type { IMediaMetadata } from '@/utils/types/media';
import type { Context } from '@opentelemetry/api';

export interface InferenceTask {
  imageSrc: string;
  hostname: string;
  createdAt: Date;
  hostSettings: IHostSettings;
  mediaMetadata: IMediaMetadata;
  priority: number; // Queue priority (higher = runs first)
  traceparent?: string;
  traceContext?: Context;
  bitmap?: ImageBitmap; // Pre-loaded bitmap (from MessageChannel transferable)
  blob?: Blob; // Blob (from Firefox structured clone) - converted to bitmap by inference library
  originalWidth?: number; // Original image dimensions (when bitmap or blob is provided)
  originalHeight?: number;
  // Timing
  requestStartAt?: number; // Timestamp when content script started processing (before fetch/decode)
  receivedAt?: number; // Timestamp when background received the message
  queueStartAt?: number; // Timestamp when task was enqueued
  fetchTime?: number; // Fetch duration (content-side, may hit cache or network)
  decodeTime?: number; // Time to createImageBitmap (content-side, Chrome only)
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
 * Model metadata from YAML file.
 */
export interface YamlModelMetadata {
  id: string;
  name: string;
  names: { [key: number]: string };
  imgsz: [number, number];
  normalize?: {
    mean: [number, number, number];
    std: [number, number, number];
  };

  description?: string;
  author?: string;
  architecture?: string;
  encoder?: string;
  date?: string;
  version?: string;
  license?: string;
  docs?: string;
  task?: string;
  kind?: string;
  batch?: number;
  channels?: number;
  size_mb?: number;
  stride?: number;
  args?: {
    batch?: number;
    half?: boolean;
    int8?: boolean;
    nms?: boolean;
    dynamic?: boolean;
  };
  input_name?: string;
  output_names?: {
    detections?: string;
    masks?: string;
  };
  output_shape?: [number, number];
}

/**
 * Model configuration used at runtime.
 */
export interface ModelMetadata {
  names: { [key: number]: string };
  imgsz: [number, number];
  /** ImageNet normalization params (null for YOLO-style 0-1 normalization) */
  normalize: {
    mean: [number, number, number];
    std: [number, number, number];
  } | null;
  namesToCheck: string[];
  /** Output mask grid dimensions [height, width] for mask transform calculations */
  outputShape: [number, number];
  /** ONNX input tensor name */
  inputName: string;
  /** ONNX output tensor names (model-specific) */
  outputNames: {
    detections: string;
    masks: string;
  };
  /** Model stride for calculating output dimensions */
  stride: number;
  /** Model task type: 'segment' for instance segmentation, 'semantic' for semantic segmentation */
  task: 'segment' | 'semantic';
  /** Whether the export has a dynamic batch dim ([N,3,H,W]); enables adaptive batching */
  dynamicBatch: boolean;
}
