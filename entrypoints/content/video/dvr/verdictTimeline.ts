import { COVERAGE_MAX_GAP_SEC } from '@/entrypoints/content/video/maskTiming';
import { MAX_VERDICT_TIMELINE_ENTRIES } from '@/utils/constants/video';

import type { ICachedFrameSample, IElementPrediction, IMaskTransform } from '@/utils/types';

export interface VerdictEntry {
  /** Media time (video.currentTime domain) of the sampled frame this verdict describes. */
  timestampSec: number;
  unsafe: boolean;
  predictions: IElementPrediction[];
  maskTransform: IMaskTransform;
  /** Inference frame dimensions the masks are relative to. */
  width: number;
  height: number;
  fromCache?: boolean;
}

/**
 * Session-lifetime bound: verdicts are small (clean entries carry no masks),
 * but a very long playback must not grow the timeline without limit. At ~4
 * verdicts/sec this covers well over 15 minutes of continuous coverage.
 */
export const MAX_TIMELINE_ENTRIES = MAX_VERDICT_TIMELINE_ENTRIES;
const CACHED_VERDICT_MAX_GAP_SEC = 0.25;
const SAME_FRAME_TOLERANCE_SEC = 0.001;

const toSeededEntry = (entry: ICachedFrameSample): VerdictEntry => ({
  timestampSec: entry.timestampSec,
  unsafe: entry.predictions.length > 0,
  predictions: entry.predictions,
  maskTransform: entry.input.maskTransform,
  width: entry.input.width,
  height: entry.input.height,
  fromCache: true,
});

export class VerdictTimeline {
  private entries: VerdictEntry[] = [];

  /** Insert in timestamp order; late-arriving older verdicts still describe their frame. */
  add(entry: VerdictEntry): number {
    let index = this.entries.length;
    while (index > 0) {
      const previous = this.entries[index - 1];
      if (!previous || previous.timestampSec <= entry.timestampSec) break;
      index--;
    }
    this.entries.splice(index, 0, entry);
    if (this.entries.length <= MAX_TIMELINE_ENTRIES) return index;
    this.entries.shift();
    return index - 1;
  }

  seed(cached: readonly ICachedFrameSample[]): VerdictEntry[] {
    const seeded = cached.filter(entry => !this.hasEntryNear(entry.timestampSec)).map(toSeededEntry);
    if (seeded.length === 0) return [];
    const merged = [...this.entries, ...seeded].sort((a, b) => a.timestampSec - b.timestampSec);
    this.entries = merged.length > MAX_TIMELINE_ENTRIES ? merged.slice(merged.length - MAX_TIMELINE_ENTRIES) : merged;
    return seeded;
  }

  dropCached(): void {
    this.entries = this.entries.filter(entry => !entry.fromCache);
  }

  indexOf(entry: VerdictEntry): number {
    return this.entries.indexOf(entry);
  }

  private hasEntryNear(timestampSec: number): boolean {
    return this.entries.some(entry => Math.abs(entry.timestampSec - timestampSec) < SAME_FRAME_TOLERANCE_SEC);
  }

  cachedVerdictAt(timestampSec: number, maxGapSec = CACHED_VERDICT_MAX_GAP_SEC): VerdictEntry | null {
    const after = this.indexAfter(timestampSec);
    const previous = this.nearestCachedEntry(after - 1, -1, timestampSec - maxGapSec);
    const next = this.nearestCachedEntry(after, 1, timestampSec + maxGapSec);
    if (!previous) return next;
    if (!next) return previous;
    return timestampSec - previous.timestampSec <= next.timestampSec - timestampSec ? previous : next;
  }

  private nearestCachedEntry(startIndex: number, step: 1 | -1, boundarySec: number): VerdictEntry | null {
    for (let index = startIndex; index >= 0 && index < this.entries.length; index += step) {
      const entry = this.entries[index];
      if (!entry) return null;
      const outOfRange = step < 0 ? entry.timestampSec < boundarySec : entry.timestampSec > boundarySec;
      if (outOfRange) return null;
      if (entry.fromCache) return entry;
    }
    return null;
  }

  /**
   * How far ahead of `fromSec` continuous verdict coverage extends: the chain
   * of verdicts starting within `maxGapSec` of the position with no
   * inter-verdict gap larger than `maxGapSec`. Sizes the presentation delay —
   * a covered range needs no inference wait, so D can be small there.
   */
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

  /** Index of the first entry strictly after `mediaTime`. */
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
