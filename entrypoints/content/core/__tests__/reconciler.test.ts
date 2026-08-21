// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Reconciler } from '@/entrypoints/content/core/Reconciler';
import { notifySrcDrift } from '@/entrypoints/content/presentation/srcDrift';

const flushMicrotasks = () => Promise.resolve();

describe('Reconciler', () => {
  let onMediaObserved: ReturnType<typeof vi.fn<(images: HTMLImageElement[], videos: HTMLVideoElement[]) => void>>;
  let onPruned: ReturnType<typeof vi.fn<(images: HTMLImageElement[]) => void>>;
  let reconciler: Reconciler;

  const image = (): HTMLImageElement => {
    const img = document.createElement('img');
    document.body.appendChild(img);
    return img;
  };

  const dirtyViaLoadEvent = (img: HTMLImageElement): void => {
    img.dispatchEvent(new Event('load'));
  };

  beforeEach(() => {
    onMediaObserved = vi.fn();
    onPruned = vi.fn();
    reconciler = new Reconciler(onMediaObserved, onPruned, 2000);
    reconciler.attachRoot(document);
  });

  afterEach(() => {
    reconciler.stop();
    reconciler.detachRoot(document);
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('observed', () => {
    it('forwards observed media to the callback synchronously', () => {
      const img = image();
      const video = document.createElement('video');

      reconciler.observed([img], [video]);

      expect(onMediaObserved).toHaveBeenCalledWith([img], [video]);
    });

    it('does not invoke the callback when nothing was observed', () => {
      reconciler.observed([], []);

      expect(onMediaObserved).not.toHaveBeenCalled();
    });

    it('indexes observed images so markAllDirty reaches them', async () => {
      const img = image();
      reconciler.observed([img], []);
      onMediaObserved.mockClear();

      reconciler.markAllDirty();
      await flushMicrotasks();

      expect(onMediaObserved).toHaveBeenCalledWith([img], []);
    });

    it('does not index videos', async () => {
      reconciler.observed([], [document.createElement('video')]);
      onMediaObserved.mockClear();

      reconciler.markAllDirty();
      await flushMicrotasks();

      expect(onMediaObserved).not.toHaveBeenCalled();
    });
  });

  describe('removed', () => {
    it('drops the image from the index and the dirty-set', async () => {
      const img = image();
      reconciler.observed([img], []);
      dirtyViaLoadEvent(img);
      onMediaObserved.mockClear();

      reconciler.removed(img);
      await flushMicrotasks();

      expect(onMediaObserved).not.toHaveBeenCalled();
    });
  });

  describe('reconcile', () => {
    it('coalesces dirty marks within one microtask checkpoint into a single reconcile pass', async () => {
      const a = image();
      const b = image();
      reconciler.observed([a, b], []);
      onMediaObserved.mockClear();

      dirtyViaLoadEvent(a);
      dirtyViaLoadEvent(b);
      await flushMicrotasks();

      expect(onMediaObserved).toHaveBeenCalledTimes(1);
      expect(onMediaObserved).toHaveBeenCalledWith([a, b], []);
    });

    it('reconciles on a microtask, not a macrotask', async () => {
      const img = image();
      reconciler.observed([img], []);
      onMediaObserved.mockClear();

      dirtyViaLoadEvent(img);
      await flushMicrotasks();

      expect(onMediaObserved).toHaveBeenCalledTimes(1);
    });

    it('prunes a disconnected dirty image and reports it via onPruned', async () => {
      const img = image();
      reconciler.observed([img], []);
      onMediaObserved.mockClear();

      dirtyViaLoadEvent(img);
      img.remove();
      await flushMicrotasks();

      expect(onMediaObserved).not.toHaveBeenCalled();
      expect(onPruned).toHaveBeenCalledWith([img]);
    });
  });

  describe('delegated capture listener', () => {
    it('indexes and dirties an image whose load fires before it was observed', async () => {
      reconciler.attachRoot(document);
      const img = image();

      img.dispatchEvent(new Event('load'));
      await flushMicrotasks();

      expect(onMediaObserved).toHaveBeenCalledWith([img], []);
    });

    it('stays silent for detached roots', async () => {
      reconciler.attachRoot(document);
      reconciler.detachRoot(document);
      const img = image();

      img.dispatchEvent(new Event('load'));
      await flushMicrotasks();

      expect(onMediaObserved).not.toHaveBeenCalled();
    });
  });

  describe('src drift', () => {
    it('a drift notification marks the image dirty and reconciles it', async () => {
      const img = image();
      reconciler.observed([img], []);
      reconciler.start();
      onMediaObserved.mockClear();

      notifySrcDrift(img);
      await flushMicrotasks();

      expect(onMediaObserved).toHaveBeenCalledWith([img], []);
    });

    it('ignores drift notifications after stop()', async () => {
      const img = image();
      reconciler.observed([img], []);
      reconciler.start();
      reconciler.stop();
      onMediaObserved.mockClear();

      notifySrcDrift(img);
      await flushMicrotasks();

      expect(onMediaObserved).not.toHaveBeenCalled();
    });
  });

  describe('safety tick', () => {
    it('reconciles all indexed images on the interval', async () => {
      vi.useFakeTimers();
      const img = image();
      reconciler.observed([img], []);
      reconciler.start();
      onMediaObserved.mockClear();

      await vi.advanceTimersByTimeAsync(2000);

      expect(onMediaObserved).toHaveBeenCalledWith([img], []);
    });

    it('prunes disconnected images from the index and reports them via onPruned', async () => {
      vi.useFakeTimers();
      const gone = image();
      const survivor = image();
      reconciler.observed([gone, survivor], []);
      reconciler.start();
      gone.remove();
      onMediaObserved.mockClear();

      await vi.advanceTimersByTimeAsync(2000);

      expect(onMediaObserved).toHaveBeenCalledWith([survivor], []);
      expect(onPruned).toHaveBeenCalledWith([gone]);
    });
  });

  describe('stop', () => {
    it('clears the index and pending dirty state', async () => {
      const img = image();
      reconciler.observed([img], []);
      dirtyViaLoadEvent(img);
      reconciler.stop();
      onMediaObserved.mockClear();

      await flushMicrotasks();
      reconciler.markAllDirty();
      await flushMicrotasks();

      expect(onMediaObserved).not.toHaveBeenCalled();
    });
  });
});
