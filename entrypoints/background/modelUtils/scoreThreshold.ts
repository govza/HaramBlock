export const MIN_SCORE_THRESHOLD = 0.05;
export const MAX_SCORE_THRESHOLD = 0.9;

/**
 * Map a user strictness in [0, 1] to a confidence threshold in [MIN_SCORE_THRESHOLD, MAX_SCORE_THRESHOLD].
 * Higher strictness lowers the threshold so more detections clear it.
 */
export function strictnessToScoreThreshold(strictness: number): number {
  const rawThreshold = 1 - strictness;
  return Math.min(MAX_SCORE_THRESHOLD, Math.max(MIN_SCORE_THRESHOLD, rawThreshold));
}
