import { DOWNGRADE_ABOVE_MS, TARGET_P75_MS } from '@/utils/inference/shared/latencyTracker';

import type { ModelPreference } from '@/utils/modelSettings';

export const BASELINE_MODEL_ID = 'sem-i320';
export const BALANCED_MODEL_ID = 'sem-i448';
export const MAX_QUALITY_MODEL_ID = 'sem-i640';
const WEBGPU_BACKEND = 'webgpu';

/**
 * Reliability guards. The previous auto switcher (removed in b12fe5f) failed on three fronts:
 * polluted latency samples, judging a model on its predecessor's samples, and in-memory cooldowns
 * that reset with every service-worker restart. The clean per-model signal now comes from
 * latencyTracker.ts; the guards below bound how often switching can happen at all, because every
 * switch tears the session down and stalls queued inference through reload + warmup.
 */
export const MIN_SAMPLES = 30; // Post-warmup samples on the current model before any decision
export const UPGRADE_COOLDOWN_MS = 30 * 60 * 1000; // Persisted via auto.lastSwitchAt
export const DOWNGRADE_COOLDOWN_MS = 5 * 60 * 1000; // Escaping a too-slow model matters more
export const MAX_AUTO_SWITCHES_PER_SESSION = 2; // The 3-rung ladder converges in at most 2 steps
export const MEASUREMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // Re-probe hardware every week at most

export interface ModelRung {
  id: string;
  inputSize: number;
}

export interface DecisionInput {
  rungs: ModelRung[]; // Ascending by inputSize
  currentModelId: string;
  backend: string;
  p75Ms: number;
  sampleCount: number;
  measured: Record<string, { p75Ms: number; at: number }>;
  lastSwitchAt?: number;
  now: number;
}

export type Decision =
  | { action: 'wait'; reason: string }
  | { action: 'settle'; reason: string }
  | { action: 'switch'; targetModelId: string; direction: 'upgrade' | 'downgrade'; reason: string };

export function isAutoPreference(preference: ModelPreference | undefined): boolean {
  return preference === undefined || preference === 'auto';
}

// sem-i640 is unusably slow without WebGPU (~247ms on WASM), so keep it WebGPU-only.
export function isBackendCapableOf(modelId: string, backend: string): boolean {
  return modelId !== MAX_QUALITY_MODEL_ID || backend === WEBGPU_BACKEND;
}

export function defaultModelIdForBackend(backend: string, rungs: ModelRung[]): string | undefined {
  if (backend === WEBGPU_BACKEND && rungs.some(r => r.id === BALANCED_MODEL_ID)) return BALANCED_MODEL_ID;
  if (rungs.some(r => r.id === BASELINE_MODEL_ID)) return BASELINE_MODEL_ID;
  return rungs[0]?.id;
}

/**
 * Pure decision core (no runtime imports, unit-tested in isolation).
 *
 * Downgrade when the current model's own p75 is over the hysteresis line. Upgrade only when the
 * next rung's estimated cost fits the budget - the estimate prefers a fresh measured p75 for that
 * rung (recorded before every past switch, so a model we downgraded away from keeps vetoing
 * re-upgrades - no flapping) and otherwise extrapolates by pixel count, which overestimates on
 * GPUs and therefore biases against risky upgrades. Anything else means we're in the right spot:
 * settle.
 */
export function decideModelSwitch(input: DecisionInput): Decision {
  const { rungs, currentModelId, backend, p75Ms, sampleCount, measured, lastSwitchAt, now } = input;

  const currentIndex = rungs.findIndex(r => r.id === currentModelId);
  const current = rungs[currentIndex];
  if (!current) return { action: 'wait', reason: `current model ${currentModelId} not in ladder` };

  if (sampleCount < MIN_SAMPLES) {
    return { action: 'wait', reason: `${sampleCount}/${MIN_SAMPLES} samples` };
  }

  const sinceSwitch = now - (lastSwitchAt ?? 0);
  const stat = `p75 ${Math.round(p75Ms)}ms over ${sampleCount} samples on ${currentModelId}/${backend}`;

  if (p75Ms > DOWNGRADE_ABOVE_MS) {
    const smaller = rungs[currentIndex - 1];
    if (!smaller) {
      return { action: 'settle', reason: `${stat} exceeds ${DOWNGRADE_ABOVE_MS}ms but no smaller model exists` };
    }
    if (sinceSwitch < DOWNGRADE_COOLDOWN_MS) {
      return { action: 'wait', reason: `downgrade cooldown (${Math.round(sinceSwitch / 1000)}s since last switch)` };
    }
    return {
      action: 'switch',
      targetModelId: smaller.id,
      direction: 'downgrade',
      reason: `${stat} > ${DOWNGRADE_ABOVE_MS}ms`,
    };
  }

  const larger = rungs[currentIndex + 1];
  if (!larger || !isBackendCapableOf(larger.id, backend)) {
    return { action: 'settle', reason: `${stat}; no larger model usable on ${backend}` };
  }

  const freshMeasurement = measured[larger.id];
  const measuredCost =
    freshMeasurement && now - freshMeasurement.at <= MEASUREMENT_TTL_MS ? freshMeasurement.p75Ms : null;
  // WASM is CPU-bound and scales ~linearly with pixel count (58→110→247ms across the rungs). GPU
  // dispatch scales much flatter (22→25→36ms) - ~sqrt of the pixel ratio per the MODEL.md tables -
  // so a quadratic predictor there would forbid upgrades the hardware handles with ease.
  const pixelRatio = (larger.inputSize * larger.inputSize) / (current.inputSize * current.inputSize);
  const scaling = backend === WEBGPU_BACKEND ? Math.sqrt(pixelRatio) : pixelRatio;
  const predictedCost = p75Ms * scaling;
  const estimatedCost = measuredCost ?? predictedCost;
  const estimateKind = measuredCost !== null ? 'measured' : 'predicted';

  if (estimatedCost > TARGET_P75_MS) {
    return {
      action: 'settle',
      reason: `${stat}; ${larger.id} ${estimateKind} ${Math.round(estimatedCost)}ms > ${TARGET_P75_MS}ms budget`,
    };
  }

  if (sinceSwitch < UPGRADE_COOLDOWN_MS) {
    return { action: 'wait', reason: `upgrade cooldown (${Math.round(sinceSwitch / 1000)}s since last switch)` };
  }

  return {
    action: 'switch',
    targetModelId: larger.id,
    direction: 'upgrade',
    reason: `${stat}; ${larger.id} ${estimateKind} ${Math.round(estimatedCost)}ms ≤ ${TARGET_P75_MS}ms budget`,
  };
}
