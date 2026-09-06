import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DVR_DELAY_MS, LATENCY_SAMPLE_COUNT } from '@/entrypoints/content/video/dvr/delay';
import { VerdictTimeline } from '@/entrypoints/content/video/dvr/verdictTimeline';
import { FrameSampler, foldLoopedMediaTime, type SamplerPorts } from '@/entrypoints/content/video/session/frameSampler';
import { createVideoSession, type SessionEvent } from '@/entrypoints/content/video/session/machine';

import type { SessionHandle } from '@/entrypoints/content/video/session/handle';

const { cancelVideoSessionInference, requestVideoFrameInference } = vi.hoisted(() => ({
  cancelVideoSessionInference: vi.fn(() => Promise.resolve()),
  requestVideoFrameInference: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/entrypoints/content/communication/sender', () => ({
  cancelVideoSessionInference,
  requestVideoFrameInference,
}));

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

class FakeVideo {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = Number.NaN;
  videoWidth = 640;
  videoHeight = 360;
  readonly cancelled: number[] = [];
  lastFrameCallback: FrameCallback | null = null;
  private nextCallbackId = 1;

  requestVideoFrameCallback = vi.fn((callback: FrameCallback) => {
    this.lastFrameCallback = callback;
    return this.nextCallbackId++;
  });
  cancelVideoFrameCallback = vi.fn((id: number) => this.cancelled.push(id));
}

function makeHandle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: 'session-1',
    video: new FakeVideo() as unknown as HTMLVideoElement,
    srcObject: null,
    src: 'https://example.test/clip.mp4',
    trace: { sessionId: 'session-1' },
    dvrWarmupSpan: null,
    dvrWarmupStartedAt: 0,
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
    dvrLastAnomalyAt: Number.NEGATIVE_INFINITY,
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

function makeSampler() {
  const dispatched: SessionEvent[] = [];
  const ringCaptures: number[] = [];
  const ports: SamplerPorts = {
    dispatch: (_handle, event) => dispatched.push(event),
    captureIntoRing: (_handle, mediaTime) => ringCaptures.push(mediaTime),
  };
  return { sampler: new FrameSampler(ports), dispatched, ringCaptures };
}

describe('FrameSampler suspension bookkeeping', () => {
  beforeEach(() => {
    vi.stubGlobal('performance', { now: () => 1_000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invalidates the in-flight capture and arms a re-sample on suspend', () => {
    const { sampler, dispatched } = makeSampler();
    const handle = makeHandle({ suspended: true, sentPlaybackFrame: true });
    handle.state = { ...handle.state, inflightIndex: 7 };
    handle.pendingSamples.set(7, {
      sessionId: 'session-1',
      frameIndex: 7,
      videoUrl: '',
      timestampSec: 3,
      capturedAt: 0,
    });

    sampler.invalidateForSuspend(handle);

    // The epoch bump is what makes a capture resolving after a fast
    // suspend→resume drop its stale frame instead of sending it.
    expect(handle.captureEpoch).toBe(1);
    expect(handle.pendingSamples.has(7)).toBe(false);
    expect(handle.pendingResample).toBe(true);
    expect(dispatched).toEqual([{ type: 'sampleCancelled', frameIndex: 7, at: 1_000 }]);
    expect(cancelVideoSessionInference).toHaveBeenCalledWith('session-1');
  });

  it('skips the cancel RPC before any playback frame was sent', () => {
    const { sampler, dispatched } = makeSampler();
    const handle = makeHandle({ suspended: true, sentPlaybackFrame: false });

    sampler.invalidateForSuspend(handle);

    expect(handle.captureEpoch).toBe(1);
    expect(cancelVideoSessionInference).not.toHaveBeenCalled();
    // No slot in flight: nothing to cancel, and no re-sample to arm.
    expect(dispatched).toEqual([]);
    expect(handle.pendingResample).toBe(false);
  });

  it('reads and clears the deferred re-sample flag exactly once', () => {
    const { sampler } = makeSampler();
    const handle = makeHandle({ pendingResample: true });

    expect(sampler.consumePendingResample(handle)).toBe(true);
    expect(sampler.consumePendingResample(handle)).toBe(false);
  });

  it('discards a deferred re-sample without reporting it', () => {
    const { sampler } = makeSampler();
    const handle = makeHandle({ pendingResample: true });

    sampler.discardPendingResample(handle);

    expect(handle.pendingResample).toBe(false);
  });

  it('defers a thumbnail capture while suspended and replays it on resume', async () => {
    const { sampler } = makeSampler();
    const handle = makeHandle({ suspended: true });

    sampler.captureThumbnail(handle);
    expect(handle.pendingThumbnailCapture).toBe(true);
    expect(requestVideoFrameInference).not.toHaveBeenCalled();

    handle.suspended = false;
    sampler.replayDeferredThumbnail(handle);
    await vi.waitFor(() => expect(handle.pendingThumbnailCapture).toBe(false));
  });

  it('strands no deferred thumbnail once a verdict has landed', () => {
    const { sampler } = makeSampler();
    const handle = makeHandle({ pendingThumbnailCapture: true });
    handle.state = { ...handle.state, lastAppliedIndex: 4 };

    sampler.replayDeferredThumbnail(handle);

    // The flag clears either way; only a still-verdict-less session re-captures.
    expect(handle.pendingThumbnailCapture).toBe(false);
    expect(requestVideoFrameInference).not.toHaveBeenCalled();
  });
});

describe('FrameSampler ticker', () => {
  it('refuses to start while suspended, disposed, or in error cooldown', () => {
    const { sampler } = makeSampler();
    for (const handle of [
      makeHandle({ suspended: true }),
      makeHandle({ state: { ...createVideoSession().state, phase: 'disposed' } }),
      makeHandle({ state: { ...createVideoSession().state, phase: 'error' } }),
    ]) {
      sampler.startTicker(handle);
      expect(handle.stopTicker).toBeNull();
    }
  });

  it('is idempotent and releases the frame callback on stop', () => {
    const { sampler } = makeSampler();
    const handle = makeHandle();
    const video = handle.video as unknown as FakeVideo;

    sampler.startTicker(handle);
    sampler.startTicker(handle);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);

    sampler.stopTicker(handle);
    expect(handle.stopTicker).toBeNull();
    expect(video.cancelled).toEqual([1]);
  });

  it('feeds the machine and the DVR ring from the same presented frame', () => {
    const { sampler, dispatched, ringCaptures } = makeSampler();
    const handle = makeHandle();
    const video = handle.video as unknown as FakeVideo;

    sampler.startTicker(handle);
    expect(video.lastFrameCallback).toBeTypeOf('function');
    video.lastFrameCallback?.(500, { mediaTime: 8.25 });

    expect(dispatched).toEqual([{ type: 'frameAvailable', at: 500, timestampSec: 8.25 }]);
    expect(ringCaptures).toEqual([8.25]);
  });

  it('folds a media time that ran past the loop back onto the timeline (Firefox rVFC)', () => {
    const { sampler, dispatched, ringCaptures } = makeSampler();
    const handle = makeHandle();
    const video = handle.video as unknown as FakeVideo;
    video.duration = 10;
    video.currentTime = 1.35;

    sampler.startTicker(handle);
    video.lastFrameCallback?.(500, { mediaTime: 11.333 });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ type: 'frameAvailable', at: 500 });
    expect((dispatched[0] as { timestampSec: number }).timestampSec).toBeCloseTo(1.333, 6);
    expect(ringCaptures).toHaveLength(1);
    expect(ringCaptures[0]).toBeCloseTo(1.333, 6);
  });
});

describe('foldLoopedMediaTime', () => {
  it('returns a media time inside the duration unchanged', () => {
    expect(foldLoopedMediaTime(8.25, 10)).toBe(8.25);
    expect(foldLoopedMediaTime(9.9, 10)).toBe(9.9);
    expect(foldLoopedMediaTime(0, 10)).toBe(0);
  });

  it('subtracts whole loops when the frame clock ran past the duration', () => {
    expect(foldLoopedMediaTime(11.333, 10)).toBeCloseTo(1.333, 6);
    expect(foldLoopedMediaTime(19.9, 10)).toBeCloseTo(9.9, 6);
    expect(foldLoopedMediaTime(190.033, 10)).toBeCloseTo(0.033, 6);
  });

  it('leaves the media time alone without a finite positive duration', () => {
    expect(foldLoopedMediaTime(11.333, Number.NaN)).toBe(11.333);
    expect(foldLoopedMediaTime(11.333, Number.POSITIVE_INFINITY)).toBe(11.333);
    expect(foldLoopedMediaTime(11.333, 0)).toBe(11.333);
  });
});

describe('FrameSampler verdict latency', () => {
  beforeEach(() => {
    vi.stubGlobal('performance', { now: () => 2_000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('settles a pending sample and records its round-trip', () => {
    const { sampler } = makeSampler();
    const handle = makeHandle();
    handle.pendingSamples.set(3, {
      sessionId: 'session-1',
      frameIndex: 3,
      videoUrl: '',
      timestampSec: 1,
      capturedAt: 1_400,
    });

    expect(sampler.recordVerdictLatency(handle, 3)).toBe(true);
    expect(handle.latenciesMs).toEqual([600]);
    expect(handle.pendingSamples.has(3)).toBe(false);
  });

  it('reports verdicts with no pending sample so the audio delay is left alone', () => {
    const { sampler } = makeSampler();
    expect(sampler.recordVerdictLatency(makeHandle(), 3)).toBe(false);
  });

  it('keeps only the most recent round-trips', () => {
    const { sampler } = makeSampler();
    const handle = makeHandle();
    for (let index = 0; index <= LATENCY_SAMPLE_COUNT; index++) {
      handle.pendingSamples.set(index, {
        sessionId: 'session-1',
        frameIndex: index,
        videoUrl: '',
        timestampSec: index,
        capturedAt: 1_000 + index,
      });
      sampler.recordVerdictLatency(handle, index);
    }

    expect(handle.latenciesMs).toHaveLength(LATENCY_SAMPLE_COUNT);
    // The oldest (longest) round-trip was evicted.
    expect(handle.latenciesMs[0]).toBe(999);
  });

  it('falls back to the default delay before any round-trip is observed', () => {
    const { sampler } = makeSampler();
    expect(sampler.currentDvrDelaySec(makeHandle())).toBe(DEFAULT_DVR_DELAY_MS / 1000);
  });

  it('derives the DVR delay from observed round-trips', () => {
    const { sampler } = makeSampler();
    const handle = makeHandle({ latenciesMs: [2_000, 2_000, 2_000] });
    expect(sampler.currentDvrDelaySec(handle)).toBe(2.75);
  });
});

describe('FrameSampler teardown', () => {
  beforeEach(() => {
    vi.stubGlobal('performance', { now: () => 3_000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cancels queued inference, stops the ticker, and drops pending samples', () => {
    const { sampler } = makeSampler();
    const handle = makeHandle({ sentPlaybackFrame: true });
    handle.pendingSamples.set(1, {
      sessionId: 'session-1',
      frameIndex: 1,
      videoUrl: '',
      timestampSec: 0,
      capturedAt: 0,
    });
    sampler.startTicker(handle);

    sampler.teardown(handle);

    expect(cancelVideoSessionInference).toHaveBeenCalledWith('session-1');
    expect(handle.stopTicker).toBeNull();
    expect((handle.video as unknown as FakeVideo).cancelled).toEqual([1]);
    expect(handle.pendingSamples.size).toBe(0);
  });
});
