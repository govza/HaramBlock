import { COVERAGE_MAX_GAP_SEC } from '@/entrypoints/content/video/maskTiming';
import { MAX_VERDICT_TIMELINE_ENTRIES } from '@/utils/constants/video';

import type { IElementPrediction, IMaskTransform } from '@/utils/types';

export interface VerdictEntry {
  timestampSec: number;
  unsafe: boolean;
  predictions: IElementPrediction[];
  maskTransform: IMaskTransform;
  width: number;
  height: number;
}

export interface MediaExtent {
  durationSec: number;
  loops: boolean;
}

const UNBOUNDED_MEDIA: MediaExtent = { durationSec: Number.POSITIVE_INFINITY, loops: false };

export const MAX_TIMELINE_ENTRIES = MAX_VERDICT_TIMELINE_ENTRIES;
const SAME_TIME_TOLERANCE_SEC = 0.000_001;

export class VerdictTimeline {
  private entries: VerdictEntry[] = [];

  add(entry: VerdictEntry): number {
    let index = this.entries.length;
    while (index > 0) {
      const previous = this.entries[index - 1];
      if (!previous || previous.timestampSec <= entry.timestampSec + SAME_TIME_TOLERANCE_SEC) break;
      index--;
    }
    const sameTime = this.entries[index - 1];
    if (sameTime && Math.abs(sameTime.timestampSec - entry.timestampSec) <= SAME_TIME_TOLERANCE_SEC) {
      if (sameTime.unsafe && !entry.unsafe) return index - 1;
      this.entries[index - 1] = entry;
      return index - 1;
    }
    this.entries.splice(index, 0, entry);
    if (this.entries.length <= MAX_TIMELINE_ENTRIES) return index;
    this.entries.shift();
    return index - 1;
  }

  coverageAheadOf(fromSec: number, media = UNBOUNDED_MEDIA, maxGapSec = COVERAGE_MAX_GAP_SEC): number {
    const { durationSec } = media;
    const reach = this.contiguousReachFrom(fromSec, maxGapSec);
    if (reach === null) return 0;
    const reachesMediaEnd = Number.isFinite(durationSec) && durationSec > 0 && reach >= durationSec - maxGapSec;
    if (!reachesMediaEnd) return Math.max(0, reach - fromSec);
    if (!media.loops) return Number.POSITIVE_INFINITY;
    const wrappedReach = this.contiguousReachFrom(0, maxGapSec);
    if (wrappedReach === null) return Math.max(0, durationSec - fromSec);
    if (wrappedReach >= fromSec - maxGapSec) return Number.POSITIVE_INFINITY;
    return Math.max(0, durationSec - fromSec) + wrappedReach;
  }

  private contiguousReachFrom(fromSec: number, maxGapSec: number): number | null {
    let last: number | null = null;
    for (const entry of this.entries) {
      if (entry.timestampSec < fromSec - maxGapSec) continue;
      if (last === null) {
        if (entry.timestampSec > fromSec + maxGapSec) return null;
      } else if (entry.timestampSec - last > maxGapSec) {
        break;
      }
      last = entry.timestampSec;
    }
    return last;
  }

  indexAfter(mediaTime: number): number {
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const entry = this.entries[mid];
      if (entry && entry.timestampSec <= mediaTime) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  at(index: number): VerdictEntry | undefined {
    return this.entries[index];
  }

  size(): number {
    return this.entries.length;
  }
}
