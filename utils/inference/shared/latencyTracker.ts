/**
 * Rolling window of pure per-image inference latency for the currently loaded model.
 *
 * Samples are recorded inside the session run lock (see modelLoader.runSession), so they measure
 * only the actual `session.run` wall time - no queue wait, no runtime-acquire/model-switch wait, no
 * pre/postprocessing, and no run-lock wait from overlapping batches. That isolation is what makes
 * the samples safe to drive automatic model switching: the old auto switcher judged models on
 * polluted end-to-end timings and ratcheted itself down to the smallest model (see docs/MODEL.md).
 *
 * The window is keyed by model + backend and resets whenever either changes, so a model is only
 * ever judged on its own samples. The first few samples after a reset are discarded as warmup
 * (first runs after a switch can still hit shader compilation / pipeline setup).
 */

const WINDOW_SIZE = 50;
const WARMUP_SKIP = 2;

// Shared latency bands: the auto switcher's decision thresholds and the popup's latency indicator
// colors both derive from these, so what the user sees always matches what auto mode would do.
//
// The budget is a throughput target, not a hardware-derived number: the GPU run is single-flight
// and batching rarely engages while images trickle in during scrolling, so per-image p75 maps
// directly to images/sec (1000 / p75). Calibrated on real browsing (2026-07-12): sem-i640 at 43ms
// p75 cleared a 153-image page in ~7s and felt slow, while sem-i448 at ~27ms (~37 img/s) felt
// right. 448's p75 predicts 640 at ~39ms, so a 35ms budget keeps auto at 448 even on fast GPUs.
export const TARGET_P75_MS = 35; // budget: largest model whose p75 fits under this is the pick
export const DOWNGRADE_ABOVE_MS = 55; // hysteresis: only above this is the current model too slow

export type LatencyBand = 'good' | 'strained' | 'overloaded';

export function classifyLatency(p75Ms: number): LatencyBand {
  if (p75Ms > DOWNGRADE_ABOVE_MS) return 'overloaded';
  if (p75Ms > TARGET_P75_MS) return 'strained';
  return 'good';
}

export interface LatencySnapshot {
  modelId: string;
  backend: string;
  sampleCount: number;
  /** p75 of per-image session.run wall time over the current window, in milliseconds. */
  p75Ms: number;
}

interface LatencyWindow {
  modelId: string;
  backend: string;
  skipped: number;
  samples: number[];
}

let activeWindow: LatencyWindow | null = null;
const listeners = new Set<() => void>();

function percentile(values: number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}

/** Record one session.run: `perImageMs` is the run's wall time divided by its batch size. */
export function recordInferenceRun(modelId: string, backend: string, perImageMs: number): void {
  if (!Number.isFinite(perImageMs) || perImageMs < 0) return;

  if (!activeWindow || activeWindow.modelId !== modelId || activeWindow.backend !== backend) {
    activeWindow = { modelId, backend, skipped: 0, samples: [] };
  }

  if (activeWindow.skipped < WARMUP_SKIP) {
    activeWindow.skipped += 1;
    return;
  }

  activeWindow.samples.push(perImageMs);
  if (activeWindow.samples.length > WINDOW_SIZE) {
    activeWindow.samples.shift();
  }

  listeners.forEach(listener => listener());
}

export function getLatencySnapshot(): LatencySnapshot | null {
  if (!activeWindow || activeWindow.samples.length === 0) return null;
  return {
    modelId: activeWindow.modelId,
    backend: activeWindow.backend,
    sampleCount: activeWindow.samples.length,
    p75Ms: percentile(activeWindow.samples, 75),
  };
}

/** True once the window holds its full WINDOW_SIZE samples (used by the settled slow guard). */
export function isLatencyWindowFull(): boolean {
  return (activeWindow?.samples.length ?? 0) >= WINDOW_SIZE;
}

/** Notifies after every recorded (post-warmup) sample. Returns an unsubscribe function. */
export function onInferenceLatencySample(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetLatencyTracker(): void {
  activeWindow = null;
}
