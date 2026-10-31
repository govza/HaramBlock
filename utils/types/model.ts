import type { IHostSettings } from '@/utils/types/host';
import type { IMediaMetadata } from '@/utils/types/media';
import type { Context } from '@opentelemetry/api';

/**
 * One image queued for background inference with the settings it is judged under. Higher
 * `priority` runs first. The pixels arrive pre-decoded as a transferred `bitmap` (MessageChannel)
 * or as a `blob` (Firefox structured clone) the inference library decodes, with the original
 * dimensions alongside; the timestamps and durations feed pipeline timing telemetry. A task from a
 * private tab never touches the persistent cache.
 */
export interface IInferenceTask {
  imageSrc: string;
  hostname: string;
  createdAt: Date;
  hostSettings: IHostSettings;
  mediaMetadata: IMediaMetadata;
  priority: number;
  isIncognito?: boolean;
  traceContext?: Context;
  bitmap?: ImageBitmap;
  blob?: Blob;
  originalWidth?: number;
  originalHeight?: number;
  requestStartAt?: number;
  receivedAt?: number;
  queueStartAt?: number;
  fetchTime?: number;
  decodeTime?: number;
}

export type ModelTask = 'segment' | 'semantic';

export type EvaluationMetric = 'mIoU' | 'mAP50-95';

/**
 * A versioned model (`<id>@<version>`) as the video verdict cache files samples under, with the
 * compatibility key (task and masked classes) that decides whether another model may read them.
 */
export interface ICacheModelVersion {
  modelId: string;
  compatibilityKey: string;
}

/**
 * A model version's offline validation result as its metadata declares it: the task's own metric on
 * a named benchmark split, overall and per class. Not read by the extension; it is the source a
 * future shared cache ranks model versions by.
 */
export interface IModelEvaluation {
  benchmark: string;
  metric: EvaluationMetric;
  score: number;
  pixelAccuracy?: number;
  classScores?: Record<string, number>;
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
export interface ICoordinateTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Model metadata from YAML file.
 */
export interface IYamlModelMetadata {
  id: string;
  name: string;
  names: { [key: number]: string };
  imgsz: [number, number];
  evaluation?: IModelEvaluation;
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
 * Model configuration used at runtime. `normalize` is null for YOLO-style 0-1 input scaling, and `dynamicBatch` (a
 * dynamic batch dim in the export) is what enables adaptive batching.
 */
export interface IModelMetadata {
  names: { [key: number]: string };
  imgsz: [number, number];
  normalize: {
    mean: [number, number, number];
    std: [number, number, number];
  } | null;
  namesToCheck: string[];
  outputShape: [number, number];
  inputName: string;
  outputNames: {
    detections: string;
    masks: string;
  };
  stride: number;
  task: ModelTask;
  dynamicBatch: boolean;
}
