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
 * D for a range whose verdicts already exist (session timeline today, shared
 * cache later): only capture/present jitter needs absorbing, not an inference
 * round-trip. Deliberately below MIN_DVR_DELAY_MS — that floor exists for
 * verdicts still in flight.
 */
export const COVERED_DVR_DELAY_MS = 300;
/** Coverage must extend at least this many multiples of the adaptive D ahead to count as covered. */
const COVERED_LOOKAHEAD_FACTOR = 2;

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

/**
 * Consecutive underrun observations before analysisUnderrun is dispatched:
 * hysteresis, so a single slow round-trip never triggers relief or demotion.
 */
export const UNDERRUN_VERDICT_STREAK = 3;

/**
 * One post-verdict underrun observation: the derived D is clamped at its
 * ceiling while coverage ahead of the playhead still trails the latched D —
 * growing D can no longer buy analysis more headroom.
 */
export function isAnalysisUnderrun(
  latenciesMs: readonly number[],
  coverageAheadSec: number,
  latchedDelaySec: number,
): boolean {
  if (computeDvrDelayMs(latenciesMs) < MAX_DVR_DELAY_MS) return false;
  return coverageAheadSec < latchedDelaySec;
}

/**
 * D at a DVR (re)start: small for a covered range, adaptive otherwise. Called
 * only at discontinuities (start, seek, loop restart) — within a continuous
 * playback run D stays latched, so presentation never jumps mid-run.
 */
export function deriveDvrDelayMs(latenciesMs: readonly number[], coverageAheadSec: number): number {
  const adaptive = computeDvrDelayMs(latenciesMs);
  const covered = coverageAheadSec * 1000 >= COVERED_LOOKAHEAD_FACTOR * adaptive;
  return covered ? COVERED_DVR_DELAY_MS : adaptive;
}
