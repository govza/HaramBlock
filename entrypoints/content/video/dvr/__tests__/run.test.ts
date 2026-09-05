import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_DVR_DELAY_MS, MAX_DVR_DELAY_MS, UNDERRUN_VERDICT_STREAK } from '@/entrypoints/content/video/dvr/delay';
import {
  startDvrRun,
  type DvrRunContext,
  type DvrRunEvent,
  type DvrRunPorts,
} from '@/entrypoints/content/video/dvr/run';
import { VerdictTimeline } from '@/entrypoints/content/video/dvr/verdictTimeline';

import type { SessionFrameStore } from '@/entrypoints/content/video/dvr/frameStoreFactory';
import type { RingQuality } from '@/entrypoints/content/video/dvr/ringBudget';

const FULL_QUALITY: RingQuality = {
  maxWidth: Number.POSITIVE_INFINITY,
  captureIntervalSec: 1 / 33,
  encodedCaptureIntervalSec: 0,
  horizonScale: 1,
};

function makeStore(): SessionFrameStore & { misses: number } {
  const store = {
    misses: 0,
    captureMode: 'video-frame' as const,
    kind: () => 'encoded' as const,
    demoteToRaw: () => {},
    push: () => {},
    frameAt: () => null,
    coveredMisses: () => store.misses,
    spanSec: () => 0,
    oldestTime: () => null,
    newestTime: () => null,
    bytes: () => 0,
    setLimits: () => {},
    release: () => {},
  };
  return store;
}

function makeHarness(options: { store?: SessionFrameStore; latenciesMs?: number[]; withTapDriver?: boolean } = {}) {
  const store = options.store ?? makeStore();
  const dispatched: DvrRunEvent[] = [];
  const onDelayChanged = vi.fn();
  let currentTime = 10;
  let nowMs = 0;
  let tapDeliver: ((frame: VideoFrame, mediaTime: number) => void) | null = null;
  const driverStop = vi.fn();
  const presenter = { isPlaybackActive: () => true, startDrain: vi.fn(), destroy: vi.fn() };
  const budget = {
    quality: () => FULL_QUALITY,
    sessionMaxBytes: () => 1024 * 1024 * 1024,
    register: vi.fn(),
    release: vi.fn(),
  };
  const markStoreKind = vi.fn();
  const ports: DvrRunPorts = {
    events: event => dispatched.push(event),
    onDelayChanged,
    surface: {
      now: () => nowMs,
      currentTime: () => currentTime,
      nativeWidth: () => 640,
      nativeHeight: () => 360,
      displayWidth: () => 640,
      drawSource: () => ({}) as CanvasImageSource,
      markStoreKind,
    },
    budget,
    createStore: () => store,
    captureDriver: onFrame => {
      if (!options.withTapDriver) return null;
      tapDeliver = onFrame;
      return { stop: driverStop };
    },
    presenter: { create: () => presenter },
  };
  const timeline = new VerdictTimeline();
  const ctx: DvrRunContext = {
    sessionId: 'session-1',
    timeline,
    latenciesMs: options.latenciesMs ?? [],
    stallFloorSec: 0,
    encodedIneligible: false,
  };
  const run = startDvrRun(ports, ctx);
  const deliverTapFrame = (mediaTime: number) => {
    tapDeliver?.({ close: () => {} } as unknown as VideoFrame, mediaTime);
  };
  return {
    run,
    store,
    dispatched,
    onDelayChanged,
    budget,
    presenter,
    driverStop,
    markStoreKind,
    timeline,
    deliverTapFrame,
    setCurrentTime: (t: number) => {
      currentTime = t;
    },
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

function addCoverage(timeline: VerdictTimeline, fromSec: number, toSec: number) {
  for (let t = fromSec; t < toSec; t += 0.5) {
    timeline.add({
      timestampSec: t,
      unsafe: false,
      predictions: [],
      maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
      width: 640,
      height: 360,
    });
  }
}

describe('DvrRun.onTick', () => {
  it('rVFC captures stand down while the push driver delivers, and resume once it stalls', () => {
    const store = makeStore();
    const setLimits = vi.spyOn(store, 'setLimits');
    const { run, deliverTapFrame } = makeHarness({ store, withTapDriver: true });

    deliverTapFrame(10);
    const tapCaptures = setLimits.mock.calls.length;

    run.onTick(10.1);
    expect(setLimits.mock.calls.length).toBe(tapCaptures);

    run.onTick(11);
    expect(setLimits.mock.calls.length).toBeGreaterThan(tapCaptures);
  });

  it('rVFC captures resume on a wall-stale tap even while the media clock crawls', () => {
    const store = makeStore();
    const setLimits = vi.spyOn(store, 'setLimits');
    const { run, deliverTapFrame, setNow } = makeHarness({ store, withTapDriver: true });

    deliverTapFrame(10);
    const tapCaptures = setLimits.mock.calls.length;

    setNow(1000);
    run.onTick(10.1);
    expect(setLimits.mock.calls.length).toBeGreaterThan(tapCaptures);
  });

  it('captures on every tick when no push driver exists', () => {
    const store = makeStore();
    const setLimits = vi.spyOn(store, 'setLimits');
    const { run } = makeHarness({ store });

    run.onTick(10.1);
    expect(setLimits).toHaveBeenCalled();
  });
});

describe('DvrRun.onVerdict delay growth', () => {
  it('a healthy store leaves the latched D untouched', () => {
    const { run, onDelayChanged } = makeHarness();

    run.onVerdict();
    expect(run.delaySec).toBe(DEFAULT_DVR_DELAY_MS / 1000);
    expect(onDelayChanged).not.toHaveBeenCalled();
  });

  it('a stalling store raises D by a bounded step and publishes the change', () => {
    const store = makeStore();
    const { run, onDelayChanged } = makeHarness({ store });
    const latched = run.delaySec;

    store.misses = 1;
    run.onVerdict();
    store.misses = 2;
    run.onVerdict();
    expect(run.delaySec).toBeGreaterThan(latched);
    expect(run.delaySec).toBeLessThanOrEqual(MAX_DVR_DELAY_MS / 1000);
    expect(onDelayChanged).toHaveBeenCalledWith(run.delaySec);

    // The same counter value on the next sync is not a fresh stall.
    const raised = run.delaySec;
    onDelayChanged.mockClear();
    run.onVerdict();
    expect(run.delaySec).toBe(raised);
    expect(onDelayChanged).not.toHaveBeenCalled();
  });

  it('misses caused by the raise itself do not ratchet D further', () => {
    const store = makeStore();
    const { run } = makeHarness({ store });

    store.misses = 1;
    run.onVerdict();
    store.misses = 2;
    run.onVerdict();
    const raised = run.delaySec;

    // Self-inflicted re-warm misses: swallowed, not a fresh stall.
    store.misses = 4;
    run.onVerdict();
    expect(run.delaySec).toBe(raised);

    // Decoder caught up: D stays put.
    run.onVerdict();
    expect(run.delaySec).toBe(raised);

    // A genuinely persistent stall still raises on the sync after the holdoff.
    store.misses = 5;
    run.onVerdict();
    expect(run.delaySec).toBeGreaterThan(raised);
  });

  it('stall-driven growth never exceeds the delay ceiling', () => {
    const store = makeStore();
    const { run } = makeHarness({ store, latenciesMs: [6000, 6000, 6000, 6000] });
    expect(run.delaySec).toBe(MAX_DVR_DELAY_MS / 1000);

    store.misses = 1;
    run.onVerdict();
    store.misses = 2;
    run.onVerdict();
    expect(run.delaySec).toBe(MAX_DVR_DELAY_MS / 1000);
  });

  it('stall-driven growth persists into the carry as the stall floor', () => {
    const store = makeStore();
    const { run } = makeHarness({ store });

    store.misses = 1;
    run.onVerdict();
    store.misses = 2;
    run.onVerdict();
    expect(run.stop().stallFloorSec).toBe(run.delaySec);
  });
});

describe('DvrRun underrun detection', () => {
  it('dispatches analysisUnderrun only after a sustained streak of underrun verdicts', () => {
    const { run, dispatched } = makeHarness({ latenciesMs: [6000, 6000, 6000, 6000] });

    for (let i = 0; i < UNDERRUN_VERDICT_STREAK - 1; i++) run.onVerdict();
    expect(dispatched).toHaveLength(0);
    run.onVerdict();
    expect(dispatched).toEqual([expect.objectContaining({ type: 'analysisUnderrun' })]);
  });

  it('a recovered verdict resets the underrun streak (transient underrun never fires)', () => {
    const { run, dispatched, timeline, setCurrentTime } = makeHarness({ latenciesMs: [6000, 6000, 6000, 6000] });

    for (let i = 0; i < UNDERRUN_VERDICT_STREAK - 1; i++) run.onVerdict();
    // Coverage catches up past the latched D: the observation clears and resets the streak.
    addCoverage(timeline, 10, 16);
    run.onVerdict();
    // The playhead outruns the coverage: underrunning again, but from a fresh streak.
    setCurrentTime(30);
    for (let i = 0; i < UNDERRUN_VERDICT_STREAK - 1; i++) run.onVerdict();
    expect(dispatched).toHaveLength(0);
  });
});

describe('DvrRun lifecycle', () => {
  it('registers demand at start and releases every port claim exactly once at stop', () => {
    const store = makeStore();
    const release = vi.spyOn(store, 'release');
    const { run, budget, presenter, driverStop, markStoreKind } = makeHarness({ store, withTapDriver: true });
    expect(budget.register).toHaveBeenCalledWith('session-1', expect.objectContaining({ nativeWidth: 640 }));

    const carry = run.stop();
    run.stop();
    expect(driverStop).toHaveBeenCalledTimes(1);
    expect(budget.release).toHaveBeenCalledTimes(1);
    expect(presenter.destroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(markStoreKind).toHaveBeenLastCalledWith(null);
    expect(carry).toEqual({ stallFloorSec: 0, encodedIneligible: false, lastAnomalyAt: Number.NEGATIVE_INFINITY });
  });

  it('a covered range derives a small D and the stall floor from the context floors it', () => {
    const timeline = new VerdictTimeline();
    addCoverage(timeline, 10, 20);
    const { run } = makeHarnessWithTimeline(timeline, 2.5);
    expect(run.delaySec).toBe(2.5);
  });
});

function makeHarnessWithTimeline(timeline: VerdictTimeline, stallFloorSec: number) {
  const store = makeStore();
  const ports: DvrRunPorts = {
    events: () => {},
    onDelayChanged: () => {},
    surface: {
      now: () => 0,
      currentTime: () => 10,
      nativeWidth: () => 640,
      nativeHeight: () => 360,
      displayWidth: () => 640,
      drawSource: () => ({}) as CanvasImageSource,
      markStoreKind: () => {},
    },
    budget: {
      quality: () => FULL_QUALITY,
      sessionMaxBytes: () => 1024 * 1024 * 1024,
      register: () => {},
      release: () => {},
    },
    createStore: () => store,
    captureDriver: () => null,
    presenter: { create: () => ({ isPlaybackActive: () => true, startDrain: () => {}, destroy: () => {} }) },
  };
  const run = startDvrRun(ports, {
    sessionId: 'session-1',
    timeline,
    latenciesMs: [],
    stallFloorSec,
    encodedIneligible: false,
  });
  return { run };
}
