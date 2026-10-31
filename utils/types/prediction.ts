import type { IRLEMask } from '@/utils/rle';
import type { IFrameSampleRouting, IVideoTimelinePosition } from '@/utils/types/media';
import type { PersistentIdentityKind } from '@/utils/types/videoIdentity';

/**
 * HTTP caching headers and bookkeeping timestamps that decide when a cached prediction expires.
 */
export interface ICacheMetadata {
  cacheControl?: string;
  etag?: string;
  lastModified?: number;
  expires?: number;

  maxAge?: number;
  createdAt: number;
  accessedAt: number;

  contentType?: string;
  contentLength?: number;
}

/**
 * One detected class in an image: its probability, bounding box and run-length encoded mask.
 */
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
  masks: IRLEMask;
}

/**
 * How an image was scaled and offset (letterboxed) to fit the model input, used to map masks back onto it.
 */
export interface IMaskTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * The inference result for one image as cached and sent to content scripts: detections, cache metadata, timings and the
 * user's Forced Visibility.
 */
export interface IImagePrediction {
  hostname: string;
  src: string;
  width: number;
  height: number;
  predictions: IElementPrediction[];
  topUnsafeScore?: number;
  timestamp: number;
  cacheMetadata: ICacheMetadata;
  maskTransform: IMaskTransform;
  processingTime: {
    fetchTime: number;
    decodeTime: number;
    queueTime: number;
    inferenceTime: number;
    e2eTime: number;
    backend: string;
    batchSize?: number;
  };
  forcedVisibility: ForcedVisibility;
  modelId?: string;
  scoreGrid?: IScoreGrid;
}

/**
 * Run-length encoded per-cell top probability and class of a semantic model output, kept so readers
 * can re-threshold it at their own strictness.
 */
export interface IScoreGrid {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  probabilityRuns: number[];
  classIdRuns: number[];
  classNames: Record<number, string>;
}

export type RawSampleScores =
  { kind: 'detections'; detections: IElementPrediction[] } | { kind: 'grid'; grid: IScoreGrid };

export type ForcedVisibility = 'auto' | 'visible' | 'blocked';

/**
 * Outcome of one image inference request, broadcast to content scripts.
 * Only the 'ok' arm carries a cacheable prediction; 'error' feeds the content
 * script's retry counter instead of leaving the image stuck behind the
 * inference watchdog. The tag is a literal union so it can grow (e.g. a
 * future 'skipped').
 */
export type ImageInferenceResult =
  | { status: 'ok'; prediction: IImagePrediction; traceparent?: string }
  | { status: 'started'; src: string; hostname: string; traceparent?: string }
  | { status: 'error'; src: string; hostname: string; reason?: string; traceparent?: string };

export function shouldBlock(prediction: IImagePrediction): boolean {
  if (prediction.forcedVisibility === 'visible') return false;
  if (prediction.forcedVisibility === 'blocked') return true;
  return Boolean(prediction.predictions?.length);
}

/**
 * Predictions for one sampled frame of a video, with its frame index, media timestamp and timings.
 */
export interface IVideoFramePrediction {
  frameIndex: number;
  timestamp: number;
  videoUrl: string;
  predictions: IElementPrediction[];
  processingTime: {
    frameExtractionTime: number;
    decodeTime: number;
    inferenceTime: number;
  };
}

/**
 * Verdict data reusable on the same video timeline. Unlike IFramePrediction,
 * it has no VideoSession routing identity and is suitable for a future cache
 * once media revision and model identity are added to its key.
 */
export interface IVideoFrameVerdict extends IVideoTimelinePosition {
  width: number;
  height: number;
  predictions: IElementPrediction[];
  scoreGrid?: IScoreGrid;
  topUnsafeScore: number;
  timestamp: number;
  cacheMetadata: ICacheMetadata;
  maskTransform: IMaskTransform;
  processingTime: {
    fetchTime: number;
    decodeTime: number;
    queueTime: number;
    inferenceTime: number;
    e2eTime: number;
    backend: string;
  };
}

/**
 * A reusable timeline verdict rebound to the VideoSession that requested it.
 */
export interface IFramePrediction extends IFrameSampleRouting, IVideoFrameVerdict {
  hostname: string;
  src: string;
}

/**
 * Geometry of the model input a sample was inferred from, needed to map its predictions back onto the video frame.
 */
export interface IInferenceInputGeometry {
  width: number;
  height: number;
  maskTransform: IMaskTransform;
}

/**
 * Pixel size of a decoded video frame before it was scaled to the model input: what a sample's
 * quality and aspect ratio are judged by.
 */
export interface IFrameSize {
  width: number;
  height: number;
}

/**
 * One lookahead sample as a video sample bucket stores it: the raw floor-threshold scores at a
 * Sample Lattice point, with the model-input geometry and source frame size its quality and aspect
 * ratio are judged by.
 */
export interface IStoredVideoSample {
  pointUs: number;
  scores: RawSampleScores;
  input: IInferenceInputGeometry;
  topUnsafeScore: number;
  source?: IFrameSize;
}

/**
 * Where a video's cached samples or Forced Visibility came from, kept on its meta row for the Cache
 * Browser: the media source URL (a dead `blob:` URL for MSE videos), the page it played on (local to
 * this device, never part of anything shared) and the host whose settings applied.
 */
export interface IVideoCacheOrigin {
  sourceUrl: string;
  pageUrl: string;
  hostname: string;
}

/**
 * One video's meta row in the verdict cache, keyed by its video identity: the duration its samples
 * were analysed against, its Forced Visibility, cache metadata, and per versioned model its sample
 * count and compatibility key (kept with the samples, so a version that no longer ships stays
 * readable by compatible ones).
 */
export interface IVideoPredictionRecord extends IVideoCacheOrigin {
  identityKey: string;
  identityKind: PersistentIdentityKind;
  durationSec: number;
  forcedVisibility: ForcedVisibility;
  timestamp: number;
  cacheMetadata: ICacheMetadata;
  sampleCounts: Record<string, number>;
  modelCompatibility: Record<string, string>;
}

export type SampleBucketKey = [identityKey: string, modelId: string, latticeVersion: number, bucketStartUs: number];

/**
 * Up to five minutes of one video's lookahead samples from one versioned model on one Sample Lattice
 * version, stored as a single row; the lattice version is part of its key so a new lattice never
 * overwrites the old one's samples. The sample format version (score floor, encoding) is not: a
 * bucket in another format is unreadable and the next write replaces it.
 */
export interface IVideoSampleBucket {
  identityKey: string;
  modelId: string;
  bucketStartUs: number;
  latticeVersion: number;
  formatVersion: number;
  hostname: string;
  samples: IStoredVideoSample[];
}

/**
 * What a session reads from the verdict cache: the stored samples and the video's Forced Visibility.
 */
export interface ICachedVideoPredictions {
  samples: IStoredVideoSample[];
  forcedVisibility: ForcedVisibility;
}

export const EMPTY_CACHED_VIDEO_PREDICTIONS: ICachedVideoPredictions = { samples: [], forcedVisibility: 'auto' };

/**
 * The inference result for one decoded frame of an animated GIF, routed back to the content script's decode session.
 */
export interface IGifFramePrediction {
  sessionId: string;
  hostname: string;
  src: string;
  frameIndex: number;
  frameCount: number;
  width: number;
  height: number;
  predictions: IElementPrediction[];
  maskTransform: IMaskTransform;
  timestamp: number;
}

/**
 * Outcome of one video frame inference request. An 'error' frees the session's
 * in-flight sample slot immediately (via the machine's transient sendFailed
 * arm) instead of waiting out the sample timeout.
 */
export type FrameInferenceResult =
  | { status: 'ok'; prediction: IFramePrediction; traceparent?: string }
  | { status: 'error'; hostname: string; sessionId: string; frameIndex: number; reason?: string; traceparent?: string };

/**
 * Outcome of one GIF frame inference request. An 'error' counts toward the
 * session's failed-frame tally so the GIF finalizes (fail closed) as soon as
 * every sampled frame is accounted for, instead of waiting out the verdict
 * timeout.
 */
export type GifFrameInferenceResult =
  | { status: 'ok'; prediction: IGifFramePrediction; traceparent?: string }
  | { status: 'error'; hostname: string; src: string; sessionId: string; reason?: string; traceparent?: string };

/**
 * Aggregate predictions for a whole video, built from its sampled frames.
 */
export interface IVideoPrediction {
  hostname: string;
  src: string;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  frameRate: number;
  frames: IVideoFramePrediction[];
  sampleInterval: number;
  timestamp: number;
  cacheMetadata: ICacheMetadata;
  maskTransform: IMaskTransform;
  processingTime: {
    fetchTime: number;
    totalInferenceTime: number;
  };
}
