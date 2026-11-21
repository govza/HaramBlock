import type { VideoIdentityKind } from '@/utils/types/videoIdentity';

export type CloudPredictionsConsent = 'unanswered' | 'declined' | 'agreed';

export type StoredModelId = string;

export type CandidateMedia =
  | { kind: 'image'; src: string; contentType?: string; cacheControl?: string }
  | { kind: 'video'; identityKind: VideoIdentityKind; identityKey?: string };

/**
 * Eligibility filter input for a Shared Prediction Cache lookup.
 */
export interface ILookupCandidate {
  media: CandidateMedia;
  hostname: string;
}

/**
 * Eligibility filter input for reporting a cached prediction.
 */
export interface IReportCandidate extends ILookupCandidate {
  modelId?: StoredModelId;
}

export type CloudPredictionsSection = { state: 'neverAgreed' } | { state: 'on' | 'off'; reporterId: string };

/**
 * What the Cloud Predictions switch shows: the stored consent answer, whether every gate of
 * `isOn()` currently passes, and the Reporter ID once the first agree created it.
 */
export interface ICloudPredictionsStatus {
  consent: CloudPredictionsConsent;
  isOn: boolean;
  reporterId?: string;
}
