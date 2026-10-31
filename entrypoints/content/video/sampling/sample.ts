import type { IFrameSampleIdentity } from '@/utils/types';

/**
 * One inference sample from a VideoSession.
 *
 * Routing identity (`sessionId`, `frameIndex`) is deliberately separate from
 * reusable media identity (`mediaKey`, `timestampSec`), so the verdict cache
 * can persist the latter while a hit is rebound to the former.
 */
export interface CapturedFrameSample extends IFrameSampleIdentity {
  bitmap: ImageBitmap;
  originalWidth: number;
  originalHeight: number;
  capturedAt: number;
}
