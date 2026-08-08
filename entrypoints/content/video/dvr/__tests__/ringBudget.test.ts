import { describe, expect, it } from 'vitest';

import {
  DVR_CAPTURE_INTERVAL_SEC,
  DvrRingBudget,
  RING_QUALITY_LADDER,
  SESSION_MAX_BYTES,
  WASM_GLOBAL_BUDGET_BYTES,
  WEBGPU_GLOBAL_BUDGET_BYTES,
} from '@/entrypoints/content/video/dvr/ringBudget';

const HD_SESSION = { nativeWidth: 1920, nativeHeight: 1080, horizonSec: 5, minHorizonSec: 2.5 };

function registerMany(budget: DvrRingBudget, count: number): string[] {
  const ids = Array.from({ length: count }, (_, i) => `session-${i}`);
  for (const id of ids) budget.register(id, HD_SESSION);
  return ids;
}

describe('DvrRingBudget', () => {
  it.each([
    ['webgpu', WEBGPU_GLOBAL_BUDGET_BYTES],
    ['wasm', WASM_GLOBAL_BUDGET_BYTES],
  ] as const)('selects the %s tier budget', (backend, expected) => {
    const budget = new DvrRingBudget();
    budget.setBackend(backend);
    expect(budget.globalBudgetBytes()).toBe(expected);
  });

  it('defaults to the conservative WASM tier until the backend is known', () => {
    expect(new DvrRingBudget().globalBudgetBytes()).toBe(WASM_GLOBAL_BUDGET_BYTES);
  });

  it('orders the ladder: width first, then fps, then horizon', () => {
    for (let i = 1; i < RING_QUALITY_LADDER.length; i++) {
      const prev = RING_QUALITY_LADDER[i - 1]!;
      const step = RING_QUALITY_LADDER[i]!;
      if (step.maxWidth < prev.maxWidth) {
        // Width degrades before anything else moves.
        expect(step.captureIntervalSec).toBe(prev.captureIntervalSec);
        expect(step.horizonScale).toBe(prev.horizonScale);
      } else if (step.captureIntervalSec > prev.captureIntervalSec) {
        // Fps degrades only at the width floor.
        expect(step.maxWidth).toBe(RING_QUALITY_LADDER.at(-1)!.maxWidth);
        expect(step.horizonScale).toBe(prev.horizonScale);
      } else {
        // Horizon shrinks only at the width and fps floor.
        expect(step.horizonScale).toBeLessThan(prev.horizonScale);
      }
    }
    // The full tier drives the presented-fps harness's ~30 fps capture cadence.
    expect(RING_QUALITY_LADDER[0]).toEqual({
      maxWidth: 640,
      captureIntervalSec: DVR_CAPTURE_INTERVAL_SEC,
      horizonScale: 1,
    });
  });

  it('keeps a single modest session at full quality', () => {
    const budget = new DvrRingBudget();
    budget.setBackend('webgpu');
    budget.register('solo', HD_SESSION);
    expect(budget.quality()).toEqual(RING_QUALITY_LADDER[0]);
  });

  it('caps a single session projection at the per-session cap instead of degrading', () => {
    const budget = new DvrRingBudget();
    budget.setBackend('webgpu');
    // Uncapped this would project far past 512 MB; the 128 MB session cap absorbs it.
    budget.register('huge', { nativeWidth: 1920, nativeHeight: 1080, horizonSec: 10_000, minHorizonSec: 2.5 });
    expect(budget.quality()).toEqual(RING_QUALITY_LADDER[0]);
    expect(budget.projectedBytes()).toBeLessThanOrEqual(SESSION_MAX_BYTES);
  });

  it('degrades sessions in ladder order as the budget tightens, and recovers in reverse', () => {
    const budget = new DvrRingBudget();
    budget.setBackend('wasm');

    const ids = registerMany(budget, 12);
    const levelAt: number[] = [];
    for (let n = 1; n <= ids.length; n++) {
      const probe = new DvrRingBudget();
      probe.setBackend('wasm');
      registerMany(probe, n);
      levelAt.push(RING_QUALITY_LADDER.indexOf(probe.quality()));
    }
    // Monotonically degrading as sessions pile on, and it actually moved.
    for (let i = 1; i < levelAt.length; i++) expect(levelAt[i]).toBeGreaterThanOrEqual(levelAt[i - 1]!);
    expect(levelAt.at(-1)!).toBeGreaterThan(0);

    // Releasing sessions recovers in reverse, back to full quality.
    const degradedLevel = RING_QUALITY_LADDER.indexOf(budget.quality());
    expect(degradedLevel).toBeGreaterThan(0);
    let previous = degradedLevel;
    for (const id of ids) {
      budget.release(id);
      const level = RING_QUALITY_LADDER.indexOf(budget.quality());
      expect(level).toBeLessThanOrEqual(previous);
      previous = level;
    }
    expect(budget.quality()).toEqual(RING_QUALITY_LADDER[0]);
  });

  it('keeps total projected demand within the global budget while degradation can still help', () => {
    const budget = new DvrRingBudget();
    budget.setBackend('wasm');
    registerMany(budget, 3);
    expect(budget.projectedBytes()).toBeLessThanOrEqual(budget.globalBudgetBytes());
  });

  it('a released session returns its capacity: remaining sessions step back up', () => {
    const budget = new DvrRingBudget();
    budget.setBackend('wasm');
    const ids = registerMany(budget, 4);
    const degraded = RING_QUALITY_LADDER.indexOf(budget.quality());
    expect(degraded).toBeGreaterThan(0);
    budget.release(ids[0]!);
    expect(RING_QUALITY_LADDER.indexOf(budget.quality())).toBeLessThan(degraded);
  });

  it('horizon shrink never projects below the D-latched floor', () => {
    const shrunk = RING_QUALITY_LADDER.at(-1)!;
    const floored = new DvrRingBudget();
    floored.register('a', { ...HD_SESSION, minHorizonSec: HD_SESSION.horizonSec });
    const free = new DvrRingBudget();
    free.register('a', { ...HD_SESSION, minHorizonSec: 0 });
    // Same session geometry; only the floor differs, so under full shrink the
    // floored session must project more bytes (its live ring holds more).
    const projectAt = (budget: DvrRingBudget) => {
      // Force the deepest tier by exhausting the budget with filler sessions.
      for (let i = 0; i < 40; i++) budget.register(`filler-${i}`, HD_SESSION);
      expect(budget.quality()).toEqual(shrunk);
      return budget.projectedBytes();
    };
    expect(projectAt(floored)).toBeGreaterThan(projectAt(free));
  });

  it('re-registering a session updates its demand instead of double counting', () => {
    const budget = new DvrRingBudget();
    budget.register('a', HD_SESSION);
    const once = budget.projectedBytes();
    budget.register('a', HD_SESSION);
    expect(budget.projectedBytes()).toBe(once);
  });
});
