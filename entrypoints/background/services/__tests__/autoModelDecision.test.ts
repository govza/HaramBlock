import { describe, expect, it } from 'vitest';

import {
  decideModelSwitch,
  defaultModelIdForBackend,
  isBackendCapableOf,
  MEASUREMENT_TTL_MS,
  type DecisionInput,
} from '@/entrypoints/background/services/autoModelDecision';

const RUNGS = [
  { id: 'sem-i320', inputSize: 320 },
  { id: 'sem-i448', inputSize: 448 },
  { id: 'sem-i640', inputSize: 640 },
];

const NOW = 1_700_000_000_000;

function input(overrides: Partial<DecisionInput>): DecisionInput {
  return {
    rungs: RUNGS,
    currentModelId: 'sem-i448',
    backend: 'webgpu',
    p75Ms: 25,
    sampleCount: 50,
    measured: {},
    lastSwitchAt: undefined,
    now: NOW,
    ...overrides,
  };
}

describe('decideModelSwitch', () => {
  it('waits until enough samples are collected', () => {
    const decision = decideModelSwitch(input({ sampleCount: 10 }));
    expect(decision.action).toBe('wait');
  });

  it('upgrades when the predicted cost of the next rung fits the budget', () => {
    // WebGPU scales ~sqrt of the pixel ratio: 20ms × √(640/448)² ≈ 29ms ≤ 35ms budget.
    const decision = decideModelSwitch(input({ p75Ms: 20 }));
    expect(decision).toMatchObject({ action: 'switch', targetModelId: 'sem-i640', direction: 'upgrade' });
  });

  it('settles when the predicted cost of the next rung exceeds the budget', () => {
    // The calibration case: a healthy sem-i448 (27ms × √(640/448)² ≈ 39ms > 35ms budget) must NOT
    // climb to sem-i640 - 640's ~43ms felt slow in real browsing.
    const decision = decideModelSwitch(input({ p75Ms: 27 }));
    expect(decision.action).toBe('settle');
  });

  it('predicts quadratically on WASM (CPU-bound scaling)', () => {
    // 20ms × (448/320)² ≈ 39ms > 35ms budget → settle; the WebGPU sqrt predictor (28ms) would
    // have upgraded, so this pins the backend split.
    const decision = decideModelSwitch(input({ currentModelId: 'sem-i320', backend: 'wasm', p75Ms: 20 }));
    expect(decision.action).toBe('settle');

    const fast = decideModelSwitch(input({ currentModelId: 'sem-i320', backend: 'wasm', p75Ms: 15 }));
    expect(fast).toMatchObject({ action: 'switch', targetModelId: 'sem-i448', direction: 'upgrade' });
  });

  it('downgrades when the current model is over the hysteresis line', () => {
    const decision = decideModelSwitch(input({ p75Ms: 90 }));
    expect(decision).toMatchObject({ action: 'switch', targetModelId: 'sem-i320', direction: 'downgrade' });
  });

  it('settles at the smallest model even when slow - nothing below to switch to', () => {
    const decision = decideModelSwitch(input({ currentModelId: 'sem-i320', backend: 'wasm', p75Ms: 120 }));
    expect(decision.action).toBe('settle');
  });

  it('vetoes a re-upgrade via the fresh measurement of a model we downgraded away from', () => {
    // After downgrading 448→320 with 448 measured at 90ms, a fast 320 must not climb back. At
    // 20ms the WebGPU prediction (20ms × √1.96 ≈ 28ms ≤ 35ms budget) would allow the upgrade, so
    // only the measured veto holds it.
    const decision = decideModelSwitch(
      input({
        currentModelId: 'sem-i320',
        p75Ms: 20,
        measured: { 'sem-i448': { p75Ms: 90, at: NOW - 1000 } },
      }),
    );
    expect(decision.action).toBe('settle');
  });

  it('ignores stale measurements past the TTL and falls back to prediction', () => {
    const decision = decideModelSwitch(
      input({
        currentModelId: 'sem-i320',
        p75Ms: 20,
        measured: { 'sem-i448': { p75Ms: 90, at: NOW - MEASUREMENT_TTL_MS - 1 } },
      }),
    );
    // WebGPU prediction: 20ms × √1.96 ≈ 28ms ≤ 35ms budget → upgrade allowed again.
    expect(decision).toMatchObject({ action: 'switch', targetModelId: 'sem-i448', direction: 'upgrade' });
  });

  it('never upgrades to sem-i640 without WebGPU', () => {
    const decision = decideModelSwitch(input({ backend: 'wasm', p75Ms: 10 }));
    expect(decision.action).toBe('settle');
  });

  it('holds upgrades during the upgrade cooldown', () => {
    const decision = decideModelSwitch(input({ p75Ms: 20, lastSwitchAt: NOW - 60_000 }));
    expect(decision.action).toBe('wait');
  });

  it('holds downgrades during the (shorter) downgrade cooldown', () => {
    const blocked = decideModelSwitch(input({ p75Ms: 90, lastSwitchAt: NOW - 60_000 }));
    expect(blocked.action).toBe('wait');

    const allowed = decideModelSwitch(input({ p75Ms: 90, lastSwitchAt: NOW - 6 * 60_000 }));
    expect(allowed.action).toBe('switch');
  });

  it('settles at the top rung when healthy', () => {
    const decision = decideModelSwitch(input({ currentModelId: 'sem-i640', p75Ms: 40 }));
    expect(decision.action).toBe('settle');
  });

  it('waits when the current model is not in the ladder', () => {
    const decision = decideModelSwitch(input({ currentModelId: 'sem-i999' }));
    expect(decision.action).toBe('wait');
  });
});

describe('isBackendCapableOf', () => {
  it('restricts only sem-i640 to WebGPU', () => {
    expect(isBackendCapableOf('sem-i640', 'wasm')).toBe(false);
    expect(isBackendCapableOf('sem-i640', 'webgpu')).toBe(true);
    expect(isBackendCapableOf('sem-i320', 'wasm')).toBe(true);
    expect(isBackendCapableOf('sem-i448', 'wasm')).toBe(true);
  });
});

describe('defaultModelIdForBackend', () => {
  it('starts WebGPU at the balanced model and WASM at the baseline', () => {
    expect(defaultModelIdForBackend('webgpu', RUNGS)).toBe('sem-i448');
    expect(defaultModelIdForBackend('wasm', RUNGS)).toBe('sem-i320');
  });

  it('falls back to the smallest rung when the known ids are absent', () => {
    expect(defaultModelIdForBackend('webgpu', [{ id: 'other', inputSize: 256 }])).toBe('other');
  });
});
