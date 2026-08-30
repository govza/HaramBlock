/**
 * Session-lifetime, time-ordered verdict history (docs/VIDEO_PROCESSING.md).
 * Verdicts are keyed by the media time of the sampled frame, so they stay
 * valid across seeks, loop restarts, and DVR stop/start. The presenter asks
 * "what applies to the frame at time t" within an inertia window sized from
 * the actual sampling cadence — the video analog of the GIF player's
 * frame-stride inertia — and the delay derivation asks how far ahead of a
 * position continuous coverage extends. Writers are live inference today and
 * the shared verdict cache later; readers never know the difference.
 */

import type { IElementPrediction, IMaskTransform } from '@/utils/types';

export interface VerdictEntry {
  /** Media time (video.currentTime domain) of the sampled frame this verdict describes. */
  timestampSec: number;
  unsafe: boolean;
  predictions: IElementPrediction[];
  maskTransform: IMaskTransform;
  /** Inference frame dimensions the masks are relative to. */
  width: number;
  height: number;
}

export type VerdictLookup =
  | { kind: 'unsafe'; entries: VerdictEntry[] }
  | { kind: 'clean' }
  /** No verdict near this frame yet (inference running late): fail closed. */
  | { kind: 'none' };

/** Past this, an upcoming unsafe verdict contributes no mask geometry. */
export const BRIDGE_HORIZON_SEC = 3;
/**
 * Session-lifetime bound: verdicts are small (clean entries carry no masks),
 * but a very long playback must not grow the timeline without limit. At ~4
 * verdicts/sec this covers well over 15 minutes of continuous coverage.
 */
export const MAX_TIMELINE_ENTRIES = 4000;
/** Two verdicts further apart than this break continuous coverage. */
export const COVERAGE_MAX_GAP_SEC = 2;

export class VerdictTimeline {
  private entries: VerdictEntry[] = [];

  /** Insert in timestamp order; late-arriving older verdicts still describe their frame. */
  add(entry: VerdictEntry): void {
    let index = this.entries.length;
    while (index > 0) {
      const previous = this.entries[index - 1];
      if (!previous || previous.timestampSec <= entry.timestampSec) break;
      index--;
    }
    this.entries.splice(index, 0, entry);
    if (this.entries.length > MAX_TIMELINE_ENTRIES) this.entries.shift();
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

  /**
   * Verdict for the frame at `mediaTime` — the clean-cut rule: a mask exists
   * exactly on the span from its unsafe sample's timestamp to the next clean
   * verdict's timestamp. Never before the unsafe sample (no pre-roll), never
   * after a clean verdict that a following clean verdict confirms — the DVR
   * delay means that confirming verdict has normally already arrived by
   * presentation time. An unconfirmed clean verdict (nothing after it yet, or
   * an unsafe verdict right after) does not cut: the mask holds, fail closed.
   *
   * Frames between two unsafe samples composite both bounding masks (inertia
   * over the unknown motion in between; a distant upcoming unsafe verdict
   * contributes no geometry). Any verdict behind covers at any distance with
   * what it knows — a clean one presents clean, an unsafe one keeps masking
   * with its own geometry: masked content beats hiding the whole frame. Only
   * genuine verdict silence behind (nothing yet, or only an upcoming unsafe
   * verdict, which is never pre-rolled) stays 'none'.
   *
   * Entries are timestamp-ordered, so the lookup binary-searches to the
   * position and reads the bounding neighbors: this runs on every draw tick of
   * every playing video, and a full-history scan would grow with the session.
   */
  verdictFor(mediaTime: number, bridgeHorizonSec = BRIDGE_HORIZON_SEC): VerdictLookup {
    const after = this.upperBound(mediaTime);
    const previous = this.entries[after - 1];
    const next = this.entries[after];

    if (!previous) {
      // No pre-masking: an upcoming unsafe verdict fails closed.
      if (next && !next.unsafe) return { kind: 'clean' };
      return { kind: 'none' };
    }

    // A distant upcoming unsafe verdict still cuts spans, but contributes no geometry.
    const nextNear = next && next.timestampSec - mediaTime <= bridgeHorizonSec ? next : null;

    if (previous.unsafe) {
      // Stale geometry over the content beats hiding the whole frame.
      return { kind: 'unsafe', entries: nextNear?.unsafe ? [previous, nextNear] : [previous] };
    }

    const before = this.entries[after - 2];
    if (before?.unsafe && (!next || next.unsafe)) {
      // The clean verdict at `previous` is unconfirmed: hold the mask.
      return { kind: 'unsafe', entries: nextNear?.unsafe ? [before, nextNear] : [before] };
    }
    return { kind: 'clean' };
  }

  /** Index of the first entry strictly after `mediaTime`. */
  private upperBound(mediaTime: number): number {
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

  size(): number {
    return this.entries.length;
  }
}
