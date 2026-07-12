import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getLatencySnapshot,
  isLatencyWindowFull,
  onInferenceLatencySample,
  recordInferenceRun,
  resetLatencyTracker,
} from '@/utils/inference/shared/latencyTracker';

const WARMUP_SKIP = 2;

function record(count: number, ms: number, modelId = 'sem-i448', backend = 'webgpu') {
  for (let i = 0; i < count; i++) recordInferenceRun(modelId, backend, ms);
}

describe('latencyTracker', () => {
  beforeEach(() => resetLatencyTracker());

  it('drops the first samples after a reset as warmup', () => {
    record(WARMUP_SKIP, 500);
    expect(getLatencySnapshot()).toBeNull();

    record(1, 20);
    expect(getLatencySnapshot()).toMatchObject({ sampleCount: 1, p75Ms: 20 });
  });

  it('resets the window (including warmup skip) when the model changes', () => {
    record(WARMUP_SKIP + 10, 20, 'sem-i320');
    expect(getLatencySnapshot()?.modelId).toBe('sem-i320');

    record(WARMUP_SKIP, 900, 'sem-i448');
    expect(getLatencySnapshot()).toBeNull(); // old samples gone, new ones still warming up

    record(4, 30, 'sem-i448');
    expect(getLatencySnapshot()).toMatchObject({ modelId: 'sem-i448', sampleCount: 4, p75Ms: 30 });
  });

  it('resets the window when the backend changes', () => {
    record(WARMUP_SKIP + 5, 20, 'sem-i448', 'webgpu');
    record(WARMUP_SKIP + 1, 110, 'sem-i448', 'wasm');
    expect(getLatencySnapshot()).toMatchObject({ backend: 'wasm', sampleCount: 1, p75Ms: 110 });
  });

  it('computes p75 over the window', () => {
    record(WARMUP_SKIP, 0);
    [10, 20, 30, 40].forEach(ms => recordInferenceRun('sem-i448', 'webgpu', ms));
    expect(getLatencySnapshot()?.p75Ms).toBe(30);
  });

  it('caps the window at 50 samples and reports fullness', () => {
    record(WARMUP_SKIP + 49, 20);
    expect(isLatencyWindowFull()).toBe(false);
    record(2, 20);
    expect(isLatencyWindowFull()).toBe(true);
    expect(getLatencySnapshot()?.sampleCount).toBe(50);
  });

  it('ignores non-finite and negative samples', () => {
    record(WARMUP_SKIP + 1, 20);
    recordInferenceRun('sem-i448', 'webgpu', Number.NaN);
    recordInferenceRun('sem-i448', 'webgpu', Number.POSITIVE_INFINITY);
    recordInferenceRun('sem-i448', 'webgpu', -5);
    expect(getLatencySnapshot()?.sampleCount).toBe(1);
  });

  it('notifies listeners only for recorded (post-warmup) samples', () => {
    const listener = vi.fn();
    const unsubscribe = onInferenceLatencySample(listener);

    record(WARMUP_SKIP, 20);
    expect(listener).not.toHaveBeenCalled();

    record(3, 20);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    record(1, 20);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
