import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VerdictTimeline } from '@/entrypoints/content/video/dvr/verdictTimeline';
import { createVideoSession, type SessionEvent } from '@/entrypoints/content/video/session/machine';
import {
  isVideoNearViewport,
  ViewportSuspension,
  type SuspensionPorts,
  type SuspensionSamplerPort,
} from '@/entrypoints/content/video/session/viewportSuspension';

import type { SessionHandle } from '@/entrypoints/content/video/session/handle';

const SUSPEND_GRACE_MS = 1_000;

class FakeVideo {
  paused = true;
  ended = false;
  currentTime = 12.5;
}

interface FakeObserverEntry {
  target: unknown;
  isIntersecting: boolean;
  boundingClientRect: { width: number; height: number };
}

/** Captures the registry's callback so tests can drive intersection changes directly. */
class FakeIntersectionObserver {
  static latest: FakeIntersectionObserver | null = null;
  readonly observed: unknown[] = [];
  readonly unobserved: unknown[] = [];

  constructor(private readonly callback: (entries: FakeObserverEntry[]) => void) {
    FakeIntersectionObserver.latest = this;
  }

  observe(target: unknown): void {
    this.observed.push(target);
  }

  unobserve(target: unknown): void {
    this.unobserved.push(target);
  }

  emit(entries: FakeObserverEntry[]): void {
    this.callback(entries);
  }
}

function makeHandle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  const video = new FakeVideo();
  return {
    sessionId: 'session-1',
    video: video as unknown as HTMLVideoElement,
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
    dvrRun: null,
    timeline: new VerdictTimeline(),
    dvrStallFloorSec: 0,
    dvrEncodedIneligible: false,
    pendingSamples: new Map(),
    latenciesMs: [],
    suspended: false,
    suspendGrace: null,
    captureEpoch: 0,
    pendingThumbnailCapture: false,
    pendingResample: false,
    sentPlaybackFrame: false,
    ...overrides,
  };
}

/** Records the suspend/resume choreography as an ordered trace, since order is the contract. */
function makeHarness() {
  const trace: string[] = [];
  const dispatched: SessionEvent[] = [];

  const sampler: SuspensionSamplerPort = {
    startTicker: () => trace.push('startTicker'),
    stopTicker: () => trace.push('stopTicker'),
    invalidateForSuspend: () => trace.push('invalidateForSuspend'),
    replayDeferredThumbnail: () => trace.push('replayDeferredThumbnail'),
    consumePendingResample: handle => {
      trace.push('consumePendingResample');
      const pending = handle.pendingResample;
      handle.pendingResample = false;
      return pending;
    },
    discardPendingResample: handle => {
      trace.push('discardPendingResample');
      handle.pendingResample = false;
    },
  };

  const ports: SuspensionPorts = {
    handleFor: () => harness.handle,
    dispatch: (_handle, event) => {
      trace.push(`dispatch:${event.type}`);
      dispatched.push(event);
    },
    sampler,
    reapplyStaticMask: () => trace.push('reapplyStaticMask'),
  };

  const harness = {
    trace,
    dispatched,
    handle: makeHandle(),
    suspension: new ViewportSuspension(ports),
    observe(handle: SessionHandle) {
      harness.handle = handle;
      harness.suspension.observe(handle);
      const observer = FakeIntersectionObserver.latest;
      if (!observer) throw new Error('observe() created no IntersectionObserver');
      return observer;
    },
  };
  return harness;
}

function entryFor(handle: SessionHandle, isIntersecting: boolean, size = { width: 320, height: 180 }) {
  return { target: handle.video, isIntersecting, boundingClientRect: size };
}

describe('ViewportSuspension', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeIntersectionObserver.latest = null;
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('suspends only after the grace period elapses', () => {
    const harness = makeHarness();
    const observer = harness.observe(makeHandle());

    observer.emit([entryFor(harness.handle, false)]);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS - 1);
    expect(harness.handle.suspended).toBe(false);
    expect(harness.trace).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(harness.handle.suspended).toBe(true);
    expect(harness.trace).toEqual(['invalidateForSuspend', 'dispatch:suspend', 'stopTicker']);
  });

  it('cancels a pending suspend when the video re-enters the margin', () => {
    const harness = makeHarness();
    const observer = harness.observe(makeHandle());

    observer.emit([entryFor(harness.handle, false)]);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS / 2);
    observer.emit([entryFor(harness.handle, true)]);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS);

    expect(harness.handle.suspended).toBe(false);
    expect(harness.handle.suspendGrace).toBeNull();
    // Never suspended, so the resume side must not run either.
    expect(harness.trace).toEqual([]);
  });

  it('never suspends a boxless player, mirroring isVideoNearViewport', () => {
    const harness = makeHarness();
    const observer = harness.observe(makeHandle());

    observer.emit([entryFor(harness.handle, false, { width: 0, height: 0 })]);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS * 2);

    expect(harness.handle.suspended).toBe(false);
    expect(harness.trace).toEqual([]);
  });

  it('hands playback back to the machine before stopping frame delivery', () => {
    const harness = makeHarness();
    const handle = makeHandle();
    handle.state = { ...handle.state, phase: 'sampling' };
    const observer = harness.observe(handle);

    observer.emit([entryFor(handle, false)]);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS);

    // Order is the contract: in-flight work dies, the machine releases DVR and
    // audio through its suspend hand-back, and only then does the ticker stop.
    expect(harness.trace).toEqual(['invalidateForSuspend', 'dispatch:suspend', 'stopTicker']);
  });

  it('dispatches the suspend hand-back outside sampling too (a paused DVR holds ring memory)', () => {
    const harness = makeHarness();
    const handle = makeHandle();
    handle.state = { ...handle.state, phase: 'standby' };
    const observer = harness.observe(handle);

    observer.emit([entryFor(handle, false)]);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS);

    expect(harness.trace).toEqual(['invalidateForSuspend', 'dispatch:suspend', 'stopTicker']);
  });

  it('resumes a playing video by discarding the deferred re-sample and replaying playback', () => {
    const harness = makeHarness();
    const handle = makeHandle({ suspended: true, pendingResample: true, pendingThumbnailCapture: true });
    (handle.video as unknown as FakeVideo).paused = false;
    const observer = harness.observe(handle);

    observer.emit([entryFor(handle, true)]);

    expect(handle.suspended).toBe(false);
    expect(harness.trace).toEqual([
      'startTicker',
      'replayDeferredThumbnail',
      'discardPendingResample',
      'dispatch:play',
    ]);
    expect(handle.pendingResample).toBe(false);
  });

  it('re-masks a paused unsafe frame and re-samples the frame that lost its verdict', () => {
    const harness = makeHarness();
    const handle = makeHandle({ suspended: true, pendingResample: true });
    handle.state = { ...handle.state, masked: true };
    const observer = harness.observe(handle);

    observer.emit([entryFor(handle, true)]);

    expect(harness.trace).toEqual([
      'startTicker',
      'replayDeferredThumbnail',
      'reapplyStaticMask',
      'consumePendingResample',
      'dispatch:seeked',
    ]);
    expect(harness.dispatched.at(-1)).toMatchObject({ type: 'seeked', timestampSec: 12.5 });
  });

  it('leaves a paused resume alone when no sample was deflected', () => {
    const harness = makeHarness();
    const handle = makeHandle({ suspended: true });
    const observer = harness.observe(handle);

    observer.emit([entryFor(handle, true)]);

    expect(harness.trace).toEqual(['startTicker', 'replayDeferredThumbnail', 'consumePendingResample']);
    expect(harness.dispatched).toEqual([]);
  });

  it('ignores intersection changes for a disposed session', () => {
    const harness = makeHarness();
    const handle = makeHandle();
    handle.state = { ...handle.state, phase: 'disposed' };
    const observer = harness.observe(handle);

    observer.emit([entryFor(handle, false)]);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS);

    expect(handle.suspended).toBe(false);
    expect(harness.trace).toEqual([]);
  });

  it('drops entries whose session is already gone', () => {
    const harness = makeHarness();
    const observer = harness.observe(makeHandle());
    const orphan = makeHandle({ sessionId: 'session-2' });
    harness.handle = undefined as unknown as SessionHandle;

    observer.emit([entryFor(orphan, false)]);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS);

    expect(orphan.suspended).toBe(false);
    expect(harness.trace).toEqual([]);
  });

  it('clearGrace cancels a pending suspend so teardown cannot fire it late', () => {
    const harness = makeHarness();
    const handle = makeHandle();
    const observer = harness.observe(handle);

    observer.emit([entryFor(handle, false)]);
    expect(handle.suspendGrace).not.toBeNull();

    harness.suspension.clearGrace(handle);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS * 2);

    expect(handle.suspendGrace).toBeNull();
    expect(handle.suspended).toBe(false);
    expect(harness.trace).toEqual([]);
  });

  it('shares one observer across sessions and unobserves on teardown', () => {
    const harness = makeHarness();
    const first = makeHandle();
    const second = makeHandle({ sessionId: 'session-2' });
    const observer = harness.observe(first);
    harness.suspension.observe(second);

    expect(FakeIntersectionObserver.latest).toBe(observer);
    expect(observer.observed).toEqual([first.video, second.video]);

    harness.suspension.unobserve(first.video);
    expect(observer.unobserved).toEqual([first.video]);
  });
});

describe('isVideoNearViewport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function videoAt(rect: Partial<DOMRect>): HTMLVideoElement {
    return {
      getBoundingClientRect: () => ({ width: 320, height: 180, top: 0, bottom: 180, left: 0, right: 320, ...rect }),
    } as unknown as HTMLVideoElement;
  }

  it('treats every video as near when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(isVideoNearViewport(videoAt({ top: 99_999, bottom: 99_999 }))).toBe(true);
  });

  it('keeps boxless players eligible so a reveal finds its verdict ready', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    expect(isVideoNearViewport(videoAt({ width: 0, height: 0 }))).toBe(true);
  });

  it('accepts a video inside the root margin and rejects one beyond it', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('innerWidth', 1_200);

    expect(isVideoNearViewport(videoAt({ top: 1_100, bottom: 1_280 }))).toBe(true);
    expect(isVideoNearViewport(videoAt({ top: 1_300, bottom: 1_480 }))).toBe(false);
    expect(isVideoNearViewport(videoAt({ top: -600, bottom: -420 }))).toBe(false);
  });
});
