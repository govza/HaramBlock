import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PredictionCache } from '@/entrypoints/content/core/predictionCache';
import { createGifInspector, GIF_VERDICT_TIMEOUT_MS, MAX_GIF_SESSIONS } from '@/entrypoints/content/gif/gifInspector';
import {
  shouldBlock,
  type GifFrameInferenceResult,
  type IElementPrediction,
  type IImagePrediction,
} from '@/utils/types';

import type { GifFrameParams } from '@/entrypoints/content/communication/sender';
import type { DecodedGif } from '@/entrypoints/content/gif/gifDecoder';

const SRC = 'https://cdn.test/a.gif';
const FRAME_COUNT = 3;

interface FakeGif {
  decoded: DecodedGif;
  closedFrames: () => number;
}

const fakeGif = (): FakeGif => {
  let closed = 0;
  const bitmap = { width: 80, height: 60, close: () => closed++ };
  return {
    decoded: {
      frames: Array.from({ length: FRAME_COUNT }, (_, frameIndex) => ({
        bitmap,
        frameIndex,
        durationMs: 100,
      })),
      totalFrames: FRAME_COUNT,
      width: 80,
      height: 60,
    },
    closedFrames: () => closed,
  };
};

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const img = (): HTMLImageElement => ({}) as HTMLImageElement;

interface Presentation {
  img: HTMLImageElement;
  verdict: IImagePrediction;
  hadPlayback: boolean;
}

const harness = () => {
  const gif = fakeGif();
  const target = img();
  const sent: GifFrameParams[] = [];
  const presented: Presentation[] = [];
  const cache = new PredictionCache(100);

  const channelReady = vi.fn(() => Promise.resolve(true));
  const decode = vi.fn((): Promise<DecodedGif | null> => Promise.resolve(gif.decoded));
  const sendFrame = vi.fn((params: GifFrameParams) => {
    sent.push(params);
    return Promise.resolve();
  });
  const isBelowMinSize = vi.fn(() => false);
  const protect = vi.fn();
  const skip = vi.fn();
  const fallback = vi.fn();

  const inspector = createGifInspector({
    hostSettings: { hostname: 'example.com' },
    cache,
    transport: { channelReady, decode, sendFrame },
    findImages: () => [target],
    priorityFor: () => 1,
    isBelowMinSize,
    protect,
    present: (element, verdict) => {
      presented.push({ img: element, verdict, hadPlayback: Boolean(inspector.playbackFor(verdict.src)) });
    },
    skip,
    fallback,
  });

  const sessionIdFor = (src: string): string => sent.find(params => params.src === src)?.sessionId ?? 'unknown';

  const frameResult = (frameIndex: number, detections = 0): GifFrameInferenceResult => ({
    status: 'ok',
    prediction: {
      sessionId: sessionIdFor(SRC),
      hostname: 'example.com',
      src: SRC,
      frameIndex,
      frameCount: FRAME_COUNT,
      width: 80,
      height: 60,
      predictions: Array.from({ length: detections }, () => ({}) as IElementPrediction),
      maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
      timestamp: 0,
    },
  });

  const frameError = (sessionId = sessionIdFor(SRC)): GifFrameInferenceResult => ({
    status: 'error',
    hostname: 'example.com',
    src: SRC,
    sessionId,
  });

  const inspectTarget = async (): Promise<void> => {
    inspector.inspect(target, SRC);
    await flush();
  };

  return {
    inspector,
    inspectTarget,
    target,
    gif,
    sent,
    presented,
    cache,
    channelReady,
    decode,
    sendFrame,
    isBelowMinSize,
    protect,
    skip,
    fallback,
    frameResult,
    frameError,
  };
};

const lastVerdict = (presented: Presentation[]): IImagePrediction | undefined => presented.at(-1)?.verdict;

describe('createGifInspector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('protects the element and sends every sampled frame', async () => {
    const { inspectTarget, protect, target, sent } = harness();
    await inspectTarget();

    expect(protect).toHaveBeenCalledWith(target);
    expect(sent.map(params => params.frameIndex)).toEqual([0, 1, 2]);
    expect(sent.every(params => params.frameCount === FRAME_COUNT)).toBe(true);
  });

  describe('finalize', () => {
    it('reveals and caches a safe GIF once every frame returned, releasing its frames', async () => {
      const { inspector, inspectTarget, presented, gif, cache, frameResult } = harness();
      await inspectTarget();

      inspector.handleFrameResults([frameResult(0), frameResult(1)]);
      expect(presented).toHaveLength(0);
      inspector.handleFrameResults([frameResult(2)]);

      const verdict = lastVerdict(presented);
      expect(verdict && shouldBlock(verdict)).toBe(false);
      expect(cache.get(SRC)).toBe(verdict);
      expect(inspector.playbackFor(SRC)).toBeUndefined();
      expect(gif.closedFrames()).toBe(FRAME_COUNT);
    });

    it('keeps frames for masked playback when a frame had a detection', async () => {
      const { inspector, inspectTarget, presented, gif, frameResult } = harness();
      await inspectTarget();

      inspector.handleFrameResults([frameResult(0), frameResult(1, 2), frameResult(2)]);

      expect(lastVerdict(presented)?.forcedVisibility).toBe('auto');
      expect(presented[0]?.hadPlayback).toBe(true);
      expect(inspector.playbackFor(SRC)?.framePredictions.size).toBe(FRAME_COUNT);
      expect(gif.closedFrames()).toBe(0);
    });

    it('counts a duplicate frame verdict once', async () => {
      const { inspector, inspectTarget, presented, frameResult } = harness();
      await inspectTarget();

      inspector.handleFrameResults([frameResult(0), frameResult(0), frameResult(1)]);
      expect(presented).toHaveLength(0);
    });

    it('fails closed when any frame errored', async () => {
      const { inspector, inspectTarget, presented, frameResult, frameError } = harness();
      await inspectTarget();

      inspector.handleFrameResults([frameResult(0), frameError(), frameResult(2)]);

      const verdict = lastVerdict(presented);
      expect(verdict?.forcedVisibility).toBe('blocked');
      expect(verdict && shouldBlock(verdict)).toBe(true);
    });

    it('fails closed when frames could not be sent', async () => {
      const { inspectTarget, presented, sendFrame } = harness();
      sendFrame.mockRejectedValue(new Error('channel closed'));
      await inspectTarget();

      expect(sendFrame).toHaveBeenCalledTimes(FRAME_COUNT);
      expect(presented).toHaveLength(1);
      expect(lastVerdict(presented)?.forcedVisibility).toBe('blocked');
    });

    it('fails closed when verdicts never arrive', async () => {
      const { inspector, inspectTarget, presented, frameResult } = harness();
      await inspectTarget();
      inspector.handleFrameResults([frameResult(0)]);

      vi.advanceTimersByTime(GIF_VERDICT_TIMEOUT_MS - 1);
      expect(presented).toHaveLength(0);
      vi.advanceTimersByTime(1);

      expect(lastVerdict(presented)?.forcedVisibility).toBe('blocked');
      expect(presented[0]?.hadPlayback).toBe(true);
    });

    it('ignores results from another session and after finalizing', async () => {
      const { inspector, inspectTarget, presented, frameResult, frameError } = harness();
      await inspectTarget();

      const foreign = frameResult(0);
      if (foreign.status === 'ok') foreign.prediction.sessionId = 'other';
      inspector.handleFrameResults([foreign, frameError('other')]);
      inspector.handleFrameResults([frameResult(0), frameResult(1), frameResult(2)]);
      inspector.handleFrameResults([frameResult(0, 5), frameError()]);

      expect(presented).toHaveLength(1);
      expect(lastVerdict(presented)?.forcedVisibility).toBe('auto');
    });
  });

  describe('repeat inspection', () => {
    it('protects another copy while the verdict is pending', async () => {
      const { inspector, inspectTarget, protect, decode } = harness();
      await inspectTarget();

      const copy = img();
      inspector.inspect(copy, SRC);
      expect(protect).toHaveBeenCalledWith(copy);
      expect(decode).toHaveBeenCalledTimes(1);
    });

    it('presents the known verdict to a later copy and lets it be replaced', async () => {
      const { inspector, inspectTarget, presented, frameResult } = harness();
      await inspectTarget();
      const blocked = { ...({} as IImagePrediction), src: SRC, forcedVisibility: 'blocked' as const };
      expect(inspector.replaceVerdict(SRC, blocked)).toBe(false);

      inspector.handleFrameResults([frameResult(0), frameResult(1), frameResult(2)]);
      expect(inspector.replaceVerdict(SRC, blocked)).toBe(true);

      const copy = img();
      inspector.inspect(copy, SRC);
      expect(presented.at(-1)).toMatchObject({ img: copy, verdict: blocked });
    });
  });

  describe('single-frame paths', () => {
    it('falls back when the GIF is not animated', async () => {
      const { inspectTarget, decode, sendFrame, fallback, target } = harness();
      decode.mockResolvedValue(null);
      await inspectTarget();

      expect(fallback).toHaveBeenCalledWith(target, SRC);
      expect(sendFrame).not.toHaveBeenCalled();
    });

    it('falls back when decoding throws', async () => {
      const { inspectTarget, decode, fallback, target } = harness();
      decode.mockRejectedValue(new Error('CORS'));
      await inspectTarget();

      expect(fallback).toHaveBeenCalledWith(target, SRC);
    });

    it('falls back without decoding when frames cannot be transferred', async () => {
      const { inspectTarget, channelReady, decode, fallback, target } = harness();
      channelReady.mockResolvedValue(false);
      await inspectTarget();

      expect(fallback).toHaveBeenCalledWith(target, SRC);
      expect(decode).not.toHaveBeenCalled();
    });

    it('skips a GIF below the minimum size', async () => {
      const { inspectTarget, isBelowMinSize, decode, skip } = harness();
      isBelowMinSize.mockReturnValue(true);
      await inspectTarget();

      expect(skip).toHaveBeenCalledWith(SRC);
      expect(decode).not.toHaveBeenCalled();
    });
  });

  describe('eviction', () => {
    it('retires the oldest finalized session, degrading a blocked GIF before closing its frames', async () => {
      const { inspector, inspectTarget, presented, gif, decode, frameResult } = harness();
      await inspectTarget();
      inspector.handleFrameResults([frameResult(0, 1), frameResult(1), frameResult(2)]);
      expect(presented[0]?.hadPlayback).toBe(true);

      decode.mockReturnValue(new Promise(() => {}));
      for (let i = 0; i < MAX_GIF_SESSIONS; i++) inspector.inspect(img(), `https://cdn.test/${i}.gif`);

      expect(presented).toHaveLength(2);
      expect(presented[1]?.hadPlayback).toBe(false);
      expect(presented[1] && shouldBlock(presented[1].verdict)).toBe(true);
      expect(gif.closedFrames()).toBe(FRAME_COUNT);
      expect(inspector.playbackFor(SRC)).toBeUndefined();
    });

    it('never evicts sessions still being inspected', async () => {
      const { inspector, decode } = harness();
      decode.mockReturnValue(new Promise(() => {}));
      for (let i = 0; i <= MAX_GIF_SESSIONS; i++) inspector.inspect(img(), `https://cdn.test/${i}.gif`);
      await flush();

      inspector.inspect(img(), 'https://cdn.test/0.gif');
      expect(decode).toHaveBeenCalledTimes(MAX_GIF_SESSIONS + 1);
    });
  });

  describe('dispose', () => {
    it('releases frames and stops the verdict timeout', async () => {
      const { inspector, inspectTarget, presented, gif } = harness();
      await inspectTarget();

      inspector.dispose();
      vi.advanceTimersByTime(GIF_VERDICT_TIMEOUT_MS);

      expect(presented).toHaveLength(0);
      expect(gif.closedFrames()).toBe(FRAME_COUNT);
    });

    it('closes frames decoded after disposal without sending them', async () => {
      let finishDecode: (decoded: DecodedGif) => void = () => {};
      const { inspector, inspectTarget, decode, sendFrame } = harness();
      decode.mockReturnValue(
        new Promise(resolve => {
          finishDecode = resolve;
        }),
      );
      await inspectTarget();

      inspector.dispose();
      const late = fakeGif();
      finishDecode(late.decoded);
      await flush();

      expect(sendFrame).not.toHaveBeenCalled();
      expect(late.closedFrames()).toBe(FRAME_COUNT);
    });

    it('does not skip a small GIF whose channel became ready after disposal', async () => {
      let markChannelReady: (ready: boolean) => void = () => {};
      const { inspector, inspectTarget, channelReady, isBelowMinSize, skip } = harness();
      channelReady.mockReturnValue(
        new Promise(resolve => {
          markChannelReady = resolve;
        }),
      );
      isBelowMinSize.mockReturnValue(true);
      await inspectTarget();

      inspector.dispose();
      markChannelReady(true);
      await flush();

      expect(skip).not.toHaveBeenCalled();
    });
  });
});
