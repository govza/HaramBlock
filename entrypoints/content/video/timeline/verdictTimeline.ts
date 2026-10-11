import { COVERAGE_MAX_GAP_SEC } from '@/entrypoints/content/video/maskTiming';

import type { IElementPrediction, IMaskTransform } from '@/utils/types';

/**
 * One sample in the Verdict Timeline (lookahead, cached or live), already judged under the
 * reader's score threshold.
 */
export interface VerdictEntry {
  timestampSec: number;
  unsafe: boolean;
  predictions: IElementPrediction[];
  maskTransform: IMaskTransform;
  width: number;
  height: number;
}

/**
 * Media length and looping, so coverage ahead can count to the media end and wrap loops.
 */
export interface MediaExtent {
  durationSec: number;
  loops: boolean;
}

const UNBOUNDED_MEDIA: MediaExtent = { durationSec: Number.POSITIVE_INFINITY, loops: false };

export const MAX_TIMELINE_ENTRIES = 4000;
const SAME_TIME_TOLERANCE_SEC = 0.000_001;

export class VerdictTimeline {
  private entries: VerdictEntry[] = [];

  add(entry: VerdictEntry, playheadSec = entry.timestampSec): void {
    let index = this.entries.length;
    while (index > 0) {
      const previous = this.entries[index - 1];
      if (!previous || previous.timestampSec <= entry.timestampSec + SAME_TIME_TOLERANCE_SEC) break;
      index--;
    }
    const sameTime = this.entries[index - 1];
    if (sameTime && Math.abs(sameTime.timestampSec - entry.timestampSec) <= SAME_TIME_TOLERANCE_SEC) {
      if (!sameTime.unsafe || entry.unsafe) this.entries[index - 1] = entry;
      return;
    }
    this.entries.splice(index, 0, entry);
    if (this.entries.length > MAX_TIMELINE_ENTRIES) this.evictFarthestFrom(playheadSec);
  }

  private evictFarthestFrom(playheadSec: number): void {
    const first = this.entries[0]?.timestampSec ?? playheadSec;
    const last = this.entries.at(-1)?.timestampSec ?? playheadSec;
    if (playheadSec - first >= last - playheadSec) this.entries.shift();
    else this.entries.pop();
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
