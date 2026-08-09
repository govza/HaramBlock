import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DVR_DELAY_MS, MAX_DVR_DELAY_MS, UNDERRUN_VERDICT_STREAK } from '@/entrypoints/content/video/dvr/delay';
import { VerdictTimeline } from '@/entrypoints/content/video/dvr/verdictTimeline';
import { createVideoSession, type SessionEvent } from '@/entrypoints/content/video/session/machine';
import { PresentationAdapter } from '@/entrypoints/content/video/session/presentationAdapter';

import type { SessionFrameStore } from '@/entrypoints/content/video/dvr/frameStoreFactory';
import type { SessionHandle } from '@/entrypoints/content/video/session/handle';

const { updateAudioDelay } = vi.hoisted(() => ({ updateAudioDelay: vi.fn() }));

vi.mock('@/entrypoints/content/video/dvr/audioDelay', () => ({
  engageAudioDelay: vi.fn(() => Promise.resolve('engaged')),
  releaseAudioDelay: vi.fn(),
  isAudioDelayEngaged: vi.fn(() => true),
  updateAudioDelay,
}));

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

function makeHandle(store: SessionFrameStore, latchedDelaySec: number): SessionHandle {
  const video = {
    currentTime: 10,
    clientWidth: 640,
    videoWidth: 640,
    videoHeight: 360,
    paused: false,
    dataset: {},
  } as unknown as HTMLVideoElement;
  return {
    sessionId: 'session-1',
    video,
    srcObject: null,
    src: 'https://example.test/clip.mp4',
    hostSettings: { hostname: 'example.test' } as SessionHandle['hostSettings'],
    state: createVideoSession().state,
    lastPrediction: null,
    lastUnsafePrediction: null,
    timers: new Map(),
    stopTicker: null,
    removeListeners: () => {},
    overlayChain: Promise.resolve(),
    dvr: {
      store,
      player: null as unknown as NonNullable<SessionHandle['dvr']>['player'],
      lastCapturedMediaTime: 0,
      captureSurface: null,
      registeredWidth: 640,
      registeredHeight: 360,
      registeredCaptureCap: 640,
      lastCoveredMisses: 0,
      underrunStreak: 0,
    },
    timeline: new VerdictTimeline(),
    dvrDelaySec: latchedDelaySec,
    dvrEncodedIneligible: false,
    pendingSamples: new Map(),
    latenciesMs: [],
    suspended: false,
    suspendGrace: null,
    captureEpoch: 0,
    pendingThumbnailCapture: false,
    pendingResample: false,
    sentPlaybackFrame: false,
  };
}

function makeAdapter() {
  const dispatched: SessionEvent[] = [];
  const adapter = new PresentationAdapter({
    dispatch: (_handle, event) => dispatched.push(event),
    currentDelaySec: handle => handle.dvrDelaySec ?? DEFAULT_DVR_DELAY_MS / 1000,
  });
  return { adapter, dispatched };
}

describe('PresentationAdapter.raiseDelayIfLagging', () => {
  beforeEach(() => updateAudioDelay.mockClear());

  it('a healthy store leaves the latched D untouched', () => {
    const { adapter } = makeAdapter();
    const handle = makeHandle(makeStore(), DEFAULT_DVR_DELAY_MS / 1000);

    adapter.raiseDelayIfLagging(handle);
    expect(handle.dvrDelaySec).toBe(DEFAULT_DVR_DELAY_MS / 1000);
    expect(updateAudioDelay).not.toHaveBeenCalled();
  });

  it('a stalling store raises D by a bounded step and updates the audio delay', () => {
    const { adapter } = makeAdapter();
    const store = makeStore();
    const latched = DEFAULT_DVR_DELAY_MS / 1000;
    const handle = makeHandle(store, latched);

    store.misses = 1;
    adapter.raiseDelayIfLagging(handle);
    expect(handle.dvrDelaySec).toBeGreaterThan(latched);
    expect(handle.dvrDelaySec).toBeLessThanOrEqual(MAX_DVR_DELAY_MS / 1000);
    expect(updateAudioDelay).toHaveBeenCalledWith(handle.video, handle.dvrDelaySec);

    // The same counter value on the next sync is not a fresh stall.
    const raised = handle.dvrDelaySec;
    updateAudioDelay.mockClear();
    adapter.raiseDelayIfLagging(handle);
    expect(handle.dvrDelaySec).toBe(raised);
    expect(updateAudioDelay).not.toHaveBeenCalled();
  });

  it('stall-driven growth never exceeds the delay ceiling', () => {
    const { adapter } = makeAdapter();
    const store = makeStore();
    const handle = makeHandle(store, MAX_DVR_DELAY_MS / 1000);

    store.misses = 1;
    adapter.raiseDelayIfLagging(handle);
    expect(handle.dvrDelaySec).toBe(MAX_DVR_DELAY_MS / 1000);
  });

  it('dispatches analysisUnderrun only after a sustained streak of underrun verdicts', () => {
    const { adapter, dispatched } = makeAdapter();
    const handle = makeHandle(makeStore(), MAX_DVR_DELAY_MS / 1000);
    handle.latenciesMs = [6000, 6000, 6000, 6000];

    for (let i = 0; i < UNDERRUN_VERDICT_STREAK - 1; i++) adapter.raiseDelayIfLagging(handle);
    expect(dispatched).toHaveLength(0);
    adapter.raiseDelayIfLagging(handle);
    expect(dispatched).toEqual([expect.objectContaining({ type: 'analysisUnderrun' })]);
  });

  it('a recovered verdict resets the underrun streak (transient underrun never fires)', () => {
    const { adapter, dispatched } = makeAdapter();
    const handle = makeHandle(makeStore(), MAX_DVR_DELAY_MS / 1000);
    handle.latenciesMs = [6000, 6000, 6000, 6000];

    for (let i = 0; i < UNDERRUN_VERDICT_STREAK - 1; i++) adapter.raiseDelayIfLagging(handle);
    // Coverage catches up past the latched D: the observation clears and resets the streak.
    for (let t = 10; t < 16; t += 0.5) {
      handle.timeline.add({
        timestampSec: t,
        unsafe: false,
        predictions: [],
        maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
        width: 640,
        height: 360,
      });
    }
    adapter.raiseDelayIfLagging(handle);
    // The playhead outruns the coverage: underrunning again, but from a fresh streak.
    (handle.video as { currentTime: number }).currentTime = 30;
    for (let i = 0; i < UNDERRUN_VERDICT_STREAK - 1; i++) adapter.raiseDelayIfLagging(handle);
    expect(dispatched).toHaveLength(0);
  });
});
