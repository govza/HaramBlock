import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createInferenceTracker,
  IMAGE_INFERENCE_TIMEOUT_MS,
  IMAGE_QUEUE_WAIT_TIMEOUT_MS,
} from '@/entrypoints/content/core/inferenceTracker';

const SRC = 'https://cdn.test/a.jpg';

const fakeImage = (state: { connected?: boolean; loaded?: boolean } = {}): HTMLImageElement =>
  ({
    isConnected: state.connected ?? true,
    complete: state.loaded ?? true,
    naturalWidth: state.loaded === false ? 0 : 200,
  }) as HTMLImageElement;

describe('createInferenceTracker', () => {
  const onTimeout = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    onTimeout.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('claim', () => {
    it('makes the first copy the owner and defers later copies to a loaded owner', () => {
      const tracker = createInferenceTracker(onTimeout);
      expect(tracker.claim(SRC, fakeImage())).toBe('owner');
      expect(tracker.claim(SRC, fakeImage())).toBe('defer');
    });

    it('lets a copy with pixels take over from a stalled owner', () => {
      const tracker = createInferenceTracker(onTimeout);
      tracker.claim(SRC, fakeImage({ loaded: false }));
      expect(tracker.claim(SRC, fakeImage({ loaded: false }))).toBe('defer');
      expect(tracker.claim(SRC, fakeImage())).toBe('owner');
    });

    it('takes over from a disconnected owner', () => {
      const tracker = createInferenceTracker(onTimeout);
      tracker.claim(SRC, fakeImage({ connected: false }));
      expect(tracker.claim(SRC, fakeImage({ loaded: false }))).toBe('owner');
    });
  });

  describe('watchdog', () => {
    it('reports a request lost in the queue after the queue-wait guard', () => {
      const tracker = createInferenceTracker(onTimeout);
      const img = fakeImage();
      tracker.claim(SRC, img);
      tracker.sent(SRC, img);

      vi.advanceTimersByTime(IMAGE_QUEUE_WAIT_TIMEOUT_MS - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledWith(SRC);
    });

    it('re-arms with the short inference timeout once the task started', () => {
      const tracker = createInferenceTracker(onTimeout);
      const img = fakeImage();
      tracker.claim(SRC, img);
      tracker.sent(SRC, img);
      tracker.started(SRC);

      vi.advanceTimersByTime(IMAGE_INFERENCE_TIMEOUT_MS);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(IMAGE_QUEUE_WAIT_TIMEOUT_MS);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('ignores started for a src nobody owns', () => {
      const tracker = createInferenceTracker(onTimeout);
      tracker.started(SRC);
      vi.advanceTimersByTime(IMAGE_QUEUE_WAIT_TIMEOUT_MS);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('stays silent when the watched owner was superseded', () => {
      const tracker = createInferenceTracker(onTimeout);
      const stalled = fakeImage({ loaded: false });
      tracker.claim(SRC, stalled);
      tracker.sent(SRC, stalled);
      tracker.claim(SRC, fakeImage());

      vi.advanceTimersByTime(IMAGE_QUEUE_WAIT_TIMEOUT_MS);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('stops once the request settles', () => {
      const tracker = createInferenceTracker(onTimeout);
      const img = fakeImage();
      tracker.claim(SRC, img);
      tracker.sent(SRC, img);
      tracker.settle(SRC);

      vi.advanceTimersByTime(IMAGE_QUEUE_WAIT_TIMEOUT_MS);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('stops on dispose', () => {
      const tracker = createInferenceTracker(onTimeout);
      const img = fakeImage();
      tracker.claim(SRC, img);
      tracker.sent(SRC, img);
      tracker.dispose();

      vi.advanceTimersByTime(IMAGE_QUEUE_WAIT_TIMEOUT_MS);
      expect(onTimeout).not.toHaveBeenCalled();
    });
  });

  describe('settle', () => {
    it('only settles for the current owner when one is named', () => {
      const tracker = createInferenceTracker(onTimeout);
      const owner = fakeImage();
      tracker.claim(SRC, owner);

      expect(tracker.settle(SRC, fakeImage())).toBe(false);
      expect(tracker.settle(SRC, owner)).toBe(true);
      expect(tracker.claim(SRC, fakeImage())).toBe('owner');
    });

    it('resets the attempt count', () => {
      const tracker = createInferenceTracker(onTimeout);
      tracker.claim(SRC, fakeImage());
      tracker.fail(SRC);
      tracker.claim(SRC, fakeImage());
      tracker.settle(SRC);

      tracker.claim(SRC, fakeImage());
      expect(tracker.fail(SRC)).toEqual({ kind: 'retry', attempts: 1 });
    });
  });

  describe('fail', () => {
    it('is untracked when nothing is pending', () => {
      const tracker = createInferenceTracker(onTimeout);
      expect(tracker.fail(SRC)).toEqual({ kind: 'untracked' });
    });

    it('retries once, then reports exhaustion and starts counting afresh', () => {
      const tracker = createInferenceTracker(onTimeout);
      tracker.claim(SRC, fakeImage());
      expect(tracker.fail(SRC)).toEqual({ kind: 'retry', attempts: 1 });
      expect(tracker.fail(SRC)).toEqual({ kind: 'untracked' });

      tracker.claim(SRC, fakeImage());
      expect(tracker.fail(SRC)).toEqual({ kind: 'exhausted', attempts: 2 });

      tracker.claim(SRC, fakeImage());
      expect(tracker.fail(SRC)).toEqual({ kind: 'retry', attempts: 1 });
    });

    it('releases ownership and its watchdog', () => {
      const tracker = createInferenceTracker(onTimeout);
      const img = fakeImage();
      tracker.claim(SRC, img);
      tracker.sent(SRC, img);
      tracker.fail(SRC);

      vi.advanceTimersByTime(IMAGE_QUEUE_WAIT_TIMEOUT_MS);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(tracker.claim(SRC, fakeImage({ loaded: false }))).toBe('owner');
    });
  });

  describe('abandon', () => {
    it('releases the owner but keeps the attempt count', () => {
      const tracker = createInferenceTracker(onTimeout);
      tracker.claim(SRC, fakeImage());
      tracker.fail(SRC);
      const retryOwner = fakeImage();
      tracker.claim(SRC, retryOwner);
      tracker.abandon(SRC, retryOwner);

      tracker.claim(SRC, fakeImage());
      expect(tracker.fail(SRC)).toEqual({ kind: 'exhausted', attempts: 2 });
    });

    it('ignores a superseded owner', () => {
      const tracker = createInferenceTracker(onTimeout);
      const stalled = fakeImage({ loaded: false });
      tracker.claim(SRC, stalled);
      tracker.claim(SRC, fakeImage());
      tracker.abandon(SRC, stalled);

      expect(tracker.claim(SRC, fakeImage())).toBe('defer');
    });
  });
});
