import type {
  ForcedVisibility,
  IImagePrediction,
  IStoredVideoSample,
  IVideoSampleBucket,
} from '@/utils/types/prediction';

export type CloudMedia = { url: string } | { key: string };

/**
 * One Own Prediction of an image as it is reported: the cached record, which already names the
 * media URL, the page's hostname and the Forced Visibility, with its model's compatibility key.
 */
export interface ICloudImageReport {
  prediction: IImagePrediction;
  compatibilityKey: string;
}

/**
 * The body of `POST /api/image-reports`: one install's batch of image reports.
 */
export interface ICloudImageReportsRequest {
  reporterId: string;
  reports: ICloudImageReport[];
}

/**
 * One video sample bucket as it is reported with the page hostname that passed the eligibility
 * filter, joined with what its meta row knows: the media, the duration the samples were analysed
 * against and the Forced Visibility.
 */
export interface ICloudVideoReport {
  media: CloudMedia;
  hostname: string;
  durationSec: number;
  forcedVisibility: ForcedVisibility;
  compatibilityKey: string;
  bucket: Pick<IVideoSampleBucket, 'modelId' | 'latticeVersion' | 'formatVersion' | 'bucketStartUs' | 'samples'>;
}

/**
 * The body of `POST /api/video-reports`: one install's report of a single bucket.
 */
export interface ICloudVideoReportRequest {
  reporterId: string;
  report: ICloudVideoReport;
}

/**
 * The body of `POST /api/prediction-lookups`: the asking model and the media it wants predictions
 * for. It names no install.
 */
export interface ICloudLookupRequest {
  model: string;
  media: CloudMedia[];
}

export type ServedImagePrediction = Omit<IImagePrediction, 'hostname' | 'forcedVisibility'>;

export type CloudLookupHit =
  | {
      kind: 'image';
      media: CloudMedia;
      compatibilityKey: string;
      formatVersion: number;
      prediction: ServedImagePrediction;
    }
  | {
      kind: 'video';
      media: CloudMedia;
      compatibilityKey: string;
      formatVersion: number;
      latticeVersion: number;
      samples: IStoredVideoSample[];
    };

export type CloudFailure =
  { status: 'rejected' } | { status: 'retryAfter'; retryAfterMs: number } | { status: 'failed' };

export type CloudReportOutcome = { status: 'ok' } | CloudFailure;

export type CloudLookupOutcome = { status: 'ok'; hits: CloudLookupHit[] } | CloudFailure;

/**
 * The one way background services talk to the Shared Prediction Cache. Every call resolves to a
 * typed outcome and never throws: `rejected` is a request the server refused for good, `retryAfter`
 * a pause it asked for, `failed` anything else worth retrying (network error, server error, an
 * aborted call).
 */
export interface ICloudPredictionsClient {
  reportImages(request: ICloudImageReportsRequest, signal?: AbortSignal): Promise<CloudReportOutcome>;
  reportVideo(request: ICloudVideoReportRequest, signal?: AbortSignal): Promise<CloudReportOutcome>;
  lookUpPredictions(request: ICloudLookupRequest, signal?: AbortSignal): Promise<CloudLookupOutcome>;
}
