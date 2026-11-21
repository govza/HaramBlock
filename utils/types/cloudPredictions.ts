export type CloudPredictionsConsent = 'unanswered' | 'declined' | 'agreed';

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
