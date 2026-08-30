import type { IFrameSampleIdentity } from '@/utils/types';

/**
 * One inference sample from a VideoSession.
 *
 * Routing identity (`sessionId`, `frameIndex`) is deliberately separate from
 * reusable media identity (`videoUrl`, `timestampSec`). A future verdict cache
 * can persist the latter while rebinding a hit to the former; this phase keeps
 * every sample session-local and in memory.
 */
export interface CapturedFrameSample extends IFrameSampleIdentity {
  bitmap: ImageBitmap;
  originalWidth: number;
  originalHeight: number;
  /** Content-process monotonic time at which capture began. */
  capturedAt: number;
}

/** Session-local lifecycle data; intentionally not a persistent cache record. */
export interface PendingFrameSample extends IFrameSampleIdentity {
  capturedAt: number;
}
