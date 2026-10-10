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

  coverageAheadOf(fromSec: number, maxGapSec = COVERAGE_MAX_GAP_SEC): number {
    let last: number | null = null;
    for (const entry of this.entries) {
      if (entry.timestampSec < fromSec - maxGapSec) continue;
      if (last === null) {
        if (entry.timestampSec > fromSec + maxGapSec) return 0;
      } else if (entry.timestampSec - last > maxGapSec) {
        break;
      }
      last = entry.timestampSec;
    }
    return last === null ? 0 : Math.max(0, last - fromSec);
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
