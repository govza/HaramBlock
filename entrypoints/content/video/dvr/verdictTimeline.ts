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

/** Detection jitter guard: a verdict never covers less than this around its sample. */
export const MIN_INERTIA_WINDOW_SEC = 0.35;
/** Ceiling so sparse sampling (throttled tabs) cannot stretch one verdict over seconds of content. */
export const MAX_INERTIA_WINDOW_SEC = 2;
/** Covers capture→verdict timestamp scatter on top of the sampling gap. */
export const INERTIA_JITTER_MARGIN_SEC = 0.15;
/** How many recent inter-verdict gaps inform the window estimate. */
const CADENCE_SAMPLE_COUNT = 8;
/**
 * How far a neighboring verdict can stretch to cover a hole in verdict
 * coverage (an inference-latency spike between two resolved samples). Bridged
 * frames show a mask or clean content instead of the whole-blur flash.
 */
export const BRIDGE_HORIZON_SEC = 3;
/**
 * A neighbor just outside the Inertia Window still covers a short overshoot —
 * for a past unsafe verdict this bounds how far its mask may extend forward
 * (a stale mask must not smear over a scene change).
 */
export const OVERSHOOT_WINDOW_MULTIPLIER = 2;
/**
 * Session-lifetime bound: verdicts are small (clean entries carry no masks),
 * but a very long playback must not grow the timeline without limit. At ~4
 * verdicts/sec this covers well over 15 minutes of continuous coverage.
 */
export const MAX_TIMELINE_ENTRIES = 4000;
/** Two verdicts further apart than this break continuous coverage. */
export const COVERAGE_MAX_GAP_SEC = MAX_INERTIA_WINDOW_SEC;

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
   * over the unknown motion in between). Past the last verdict an unsafe mask
   * covers only a short overshoot, and a span wider than the bridge horizon
   * whole-blurs — that far out the stale geometry no longer describes the
   * scene. Only genuine verdict silence stays 'none'.
   *
   * Entries are timestamp-ordered, so the lookup binary-searches to the
   * position and reads the bounding neighbors: this runs on every draw tick of
   * every playing video, and a full-history scan would grow with the session.
   */
  verdictFor(mediaTime: number, windowSec: number, bridgeHorizonSec = BRIDGE_HORIZON_SEC): VerdictLookup {
    const after = this.upperBound(mediaTime);
    const previous = this.entries[after - 1];
    const next = this.entries[after];

    if (!previous) {
      // Nothing describes any frame at or before this one. No pre-masking: an
      // upcoming clean verdict near warm-up presents clean, anything else
      // fails closed with the whole-blur.
      if (next && !next.unsafe && next.timestampSec - mediaTime <= windowSec * OVERSHOOT_WINDOW_MULTIPLIER) {
        return { kind: 'clean' };
      }
      return { kind: 'none' };
    }

    // A verdict beyond the bridge horizon no longer describes this frame:
    // never composite its mask geometry here, and never let a clean pair
    // bridge across a hole that wide — whole-blur instead.
    const nextNear = next && next.timestampSec - mediaTime <= bridgeHorizonSec ? next : null;

    if (previous.unsafe) {
      if (next) {
        if (mediaTime - previous.timestampSec > bridgeHorizonSec) return { kind: 'none' };
        return { kind: 'unsafe', entries: nextNear?.unsafe ? [previous, nextNear] : [previous] };
      }
      // Live edge: cover a short overshoot ahead of the newest unsafe sample,
      // then whole-blur so a stale mask cannot smear over a scene change.
      if (mediaTime - previous.timestampSec <= windowSec * OVERSHOOT_WINDOW_MULTIPLIER) {
        return { kind: 'unsafe', entries: [previous] };
      }
      return { kind: 'none' };
    }

    const before = this.entries[after - 2];
    if (before?.unsafe && (!next || next.unsafe)) {
      // The clean verdict at `previous` is unconfirmed: hold the mask.
      if (mediaTime - before.timestampSec > bridgeHorizonSec) return { kind: 'none' };
      return { kind: 'unsafe', entries: nextNear?.unsafe ? [before, nextNear] : [before] };
    }
    if (mediaTime - previous.timestampSec <= (nextNear ? bridgeHorizonSec : windowSec * OVERSHOOT_WINDOW_MULTIPLIER)) {
      return { kind: 'clean' };
    }
    // Far from the clean verdict behind, but just ahead of an upcoming clean
    // one (seek into a hole): the short approach presents clean.
    if (nextNear && !nextNear.unsafe && nextNear.timestampSec - mediaTime <= windowSec * OVERSHOOT_WINDOW_MULTIPLIER) {
      return { kind: 'clean' };
    }
    return { kind: 'none' };
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

  /**
   * Inertia window derived from the observed verdict cadence (median of recent
   * gaps + jitter margin) instead of a hardcoded interval, clamped so both a
   * burst of verdicts and a throttled trickle stay sane.
   */
  inertiaWindowSec(): number {
    const gaps: number[] = [];
    const first = Math.max(1, this.entries.length - CADENCE_SAMPLE_COUNT);
    for (let i = first; i < this.entries.length; i++) {
      const previous = this.entries[i - 1];
      const current = this.entries[i];
      if (previous && current) gaps.push(current.timestampSec - previous.timestampSec);
    }
    if (!gaps.length) return MIN_INERTIA_WINDOW_SEC + INERTIA_JITTER_MARGIN_SEC;
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
    const clamped = Math.min(MAX_INERTIA_WINDOW_SEC, Math.max(MIN_INERTIA_WINDOW_SEC, median));
    return clamped + INERTIA_JITTER_MARGIN_SEC;
  }

  size(): number {
    return this.entries.length;
  }
}
