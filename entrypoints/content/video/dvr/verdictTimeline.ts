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
   * Verdict for the frame at `mediaTime`: any unsafe verdict within the window
   * masks (all of them merged — inertia stretches each over the sampling gap),
   * a clean verdict clears.
   *
   * A hole in coverage (no verdict within the window — an inference-latency
   * spike) is bridged from the neighbors instead of whole-blurring, which read
   * as an annoying blur flash between masked stretches: an upcoming unsafe
   * verdict extends its masks backward over the hole (pre-roll before known
   * content), a past unsafe verdict only covers a short forward overshoot so a
   * stale mask cannot smear over a scene change, a hole between two clean
   * verdicts presents clean, and a lone clean neighbor covers a short
   * overshoot. Only genuine verdict silence stays 'none'.
   *
   * Entries are timestamp-ordered, so the lookup binary-searches to the
   * position and scans outward: this runs on every draw tick of every playing
   * video, and a full-history scan would grow with the session.
   */
  verdictFor(mediaTime: number, windowSec: number, bridgeHorizonSec = BRIDGE_HORIZON_SEC): VerdictLookup {
    const after = this.upperBound(mediaTime);
    const unsafeInWindow: VerdictEntry[] = [];
    let anyInWindow = false;
    for (let index = after - 1; index >= 0; index--) {
      const entry = this.entries[index];
      if (!entry || mediaTime - entry.timestampSec > windowSec) break;
      anyInWindow = true;
      if (entry.unsafe) unsafeInWindow.push(entry);
    }
    unsafeInWindow.reverse();
    for (let index = after; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (!entry || entry.timestampSec - mediaTime > windowSec) break;
      anyInWindow = true;
      if (entry.unsafe) unsafeInWindow.push(entry);
    }
    if (anyInWindow) {
      return unsafeInWindow.length ? { kind: 'unsafe', entries: unsafeInWindow } : { kind: 'clean' };
    }

    const previousEntry = this.entries[after - 1];
    const previous = previousEntry && mediaTime - previousEntry.timestampSec <= bridgeHorizonSec ? previousEntry : null;
    const nextEntry = this.entries[after];
    const next = nextEntry && nextEntry.timestampSec - mediaTime <= bridgeHorizonSec ? nextEntry : null;

    const unsafeNeighbors: VerdictEntry[] = [];
    if (previous?.unsafe && mediaTime - previous.timestampSec <= windowSec * OVERSHOOT_WINDOW_MULTIPLIER) {
      unsafeNeighbors.push(previous);
    }
    if (next?.unsafe) unsafeNeighbors.push(next);
    if (unsafeNeighbors.length) return { kind: 'unsafe', entries: unsafeNeighbors };
    // Past the overshoot a stale mask must not smear over a scene change — but
    // a hole trailing an unsafe verdict is not evidence of clean content
    // either. Whole-blur it instead of bridging to 'clean'.
    if (previous?.unsafe) return { kind: 'none' };
    if (previous && next) return { kind: 'clean' };
    const lone = previous ?? next;
    if (lone && Math.abs(lone.timestampSec - mediaTime) <= windowSec * OVERSHOOT_WINDOW_MULTIPLIER) {
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
