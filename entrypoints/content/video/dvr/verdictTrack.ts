/**
 * Time-ordered verdict history for the DVR presentation path
 * (docs/VIDEO_PROCESSING.md). Verdicts are keyed by the media time of the
 * sampled frame; the presenter asks "what applies to the frame at time t"
 * within an inertia window sized from the actual sampling cadence — the video
 * analog of the GIF player's frame-stride inertia.
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
/** Keep the last unsafe mask through short clean detector dropouts. */
export const TRAILING_UNSAFE_INERTIA_MULTIPLIER = 2;

export class VerdictTrack {
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
  }

  /**
   * Verdict for the frame at `mediaTime`: any unsafe verdict within the window
   * masks (all of them merged — inertia stretches each over the sampling gap),
   * a clean verdict clears.
   *
   * A hole in coverage (no verdict within the window — an inference-latency
   * spike) is bridged from the neighbors instead of whole-blurring, which read
   * as an annoying blur flash between masked stretches: an unsafe neighbor
   * always extends its masks over the hole (the fail-safe direction), a hole
   * between two clean verdicts presents clean, and a lone clean neighbor
   * covers a short overshoot. Only genuine verdict silence stays 'none'.
   */
  verdictFor(mediaTime: number, windowSec: number, bridgeHorizonSec = BRIDGE_HORIZON_SEC): VerdictLookup {
    const inWindow = this.entries.filter(entry => Math.abs(entry.timestampSec - mediaTime) <= windowSec);
    if (inWindow.length) {
      const unsafe = inWindow.filter(entry => entry.unsafe);
      if (unsafe.length) return { kind: 'unsafe', entries: unsafe };

      // Clean samples inside the symmetric cadence window do not immediately
      // erase a recent unsafe mask. Segmentation detections commonly miss for
      // a handful of frames; trailing inertia prevents the visible patch from
      // blinking open/closed at sample cadence while still allowing sustained
      // clean playback to clear it.
      const unsafeHoldSec = windowSec * TRAILING_UNSAFE_INERTIA_MULTIPLIER;
      const previousUnsafe = this.entries.findLast(
        entry => entry.unsafe && entry.timestampSec <= mediaTime && mediaTime - entry.timestampSec <= unsafeHoldSec,
      );
      return previousUnsafe ? { kind: 'unsafe', entries: [previousUnsafe] } : { kind: 'clean' };
    }

    const previous = this.entries.findLast(
      entry => entry.timestampSec <= mediaTime && mediaTime - entry.timestampSec <= bridgeHorizonSec,
    );
    const next = this.entries.find(
      entry => entry.timestampSec >= mediaTime && entry.timestampSec - mediaTime <= bridgeHorizonSec,
    );

    const unsafeNeighbors = [previous, next].filter((entry): entry is VerdictEntry => Boolean(entry?.unsafe));
    if (unsafeNeighbors.length) return { kind: 'unsafe', entries: unsafeNeighbors };
    if (previous && next) return { kind: 'clean' };
    const lone = previous ?? next;
    if (lone && Math.abs(lone.timestampSec - mediaTime) <= windowSec * 2) return { kind: 'clean' };
    return { kind: 'none' };
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

  /** Drop verdicts older than `beforeSec`; the presenter prunes to the buffer horizon. */
  prune(beforeSec: number): void {
    let firstKept = 0;
    while (firstKept < this.entries.length) {
      const entry = this.entries[firstKept];
      if (!entry || entry.timestampSec >= beforeSec) break;
      firstKept++;
    }
    if (firstKept > 0) this.entries.splice(0, firstKept);
  }

  size(): number {
    return this.entries.length;
  }
}
