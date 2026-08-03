import type { IImagePrediction } from '@/utils/types';

/**
 * Check whether a cached prediction is still valid per its cache metadata.
 * An entry expires when the Expires timestamp has passed or its age exceeds
 * maxAge (seconds); with neither rule set it never expires.
 */
export function isValidPrediction(prediction: IImagePrediction, now: number = Date.now()): boolean {
  if (prediction.cacheMetadata.expires && now > prediction.cacheMetadata.expires) {
    return false;
  }

  if (prediction.cacheMetadata.maxAge) {
    const ageInSeconds = (now - prediction.cacheMetadata.createdAt) / 1000;
    if (ageInSeconds > prediction.cacheMetadata.maxAge) {
      return false;
    }
  }

  return true;
}
