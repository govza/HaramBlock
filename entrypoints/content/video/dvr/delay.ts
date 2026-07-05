/**
 * Adaptive Presentation Delay D (docs/VIDEO_PROCESSING.md): the DVR presents
 * `currentTime − D`, so a presented frame's verdict is resolved iff its
 * sample→verdict round-trip fit inside D. Size D from the session's observed
 * round-trips (high percentile + headroom) instead of assuming a fixed value —
 * a busy page with HD frames can take multiples of the small-fixture latency.
 */

/** Floor: below this, capture/present jitter alone can outrun the delay. */
export const MIN_DVR_DELAY_MS = 1200;
/** Ceiling: beyond this, the lag between reality and presentation gets disorienting. */
export const MAX_DVR_DELAY_MS = 4000;
/** Used until the first round-trips are observed. */
export const DEFAULT_DVR_DELAY_MS = 1500;
/** How many recent round-trips inform the estimate. */
export const LATENCY_SAMPLE_COUNT = 16;
/** Slack over the observed round-trip: send pacing + verdict-delivery jitter. */
const LATENCY_HEADROOM_FACTOR = 1.25;
const LATENCY_HEADROOM_MS = 250;

/**
 * D from recent sample→verdict round-trips: ~p90 with headroom, clamped.
 * Deliberately quantile-based — one pathological outlier must not pin the
 * delay at the ceiling for the rest of the session.
 */
export function computeDvrDelayMs(latenciesMs: readonly number[]): number {
  if (!latenciesMs.length) return DEFAULT_DVR_DELAY_MS;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? DEFAULT_DVR_DELAY_MS;
  const withHeadroom = p90 * LATENCY_HEADROOM_FACTOR + LATENCY_HEADROOM_MS;
  return Math.min(MAX_DVR_DELAY_MS, Math.max(MIN_DVR_DELAY_MS, Math.round(withHeadroom)));
}
