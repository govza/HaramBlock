// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DomObserver, type DomObserverConfig } from '@/entrypoints/content/core/DomObserver';

const flushMutationsAndReconcile = () => new Promise<void>(resolve => setTimeout(resolve));

describe('DomObserver reconciliation pass', () => {
  let observer: DomObserver;
  let onMediaObserved: ReturnType<typeof vi.fn<DomObserverConfig['onMediaObserved']>>;

  const startObserver = (config: Partial<DomObserverConfig> = {}): DomObserver => {
    observer = new DomObserver({
      onMediaObserved,
      onMediaRemoved: vi.fn(),
      onAttributesChanged: vi.fn(),
      ...config,
    });
    observer.start(document);
    return observer;
  };

  const addImage = (parent: ParentNode = document.body): HTMLImageElement => {
    const img = document.createElement('img');
    img.src = 'https://example.com/a.jpg';
    parent.appendChild(img);
    return img;
  };

  beforeEach(() => {
    onMediaObserved = vi.fn();
  });

  afterEach(() => {
    observer?.stop();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('reports already-present images at start without any load event', () => {
    const img = addImage();
    startObserver();

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('reconciles an image when its load event fires (delegated capture listener)', async () => {
    const img = addImage();
    startObserver();
    onMediaObserved.mockClear();

    img.dispatchEvent(new Event('load'));
    await flushMutationsAndReconcile();

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('reconciles an image when its error event fires', async () => {
    const img = addImage();
    startObserver();
    onMediaObserved.mockClear();

    img.dispatchEvent(new Event('error'));
    await flushMutationsAndReconcile();

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('coalesces multiple dirty marks into one reconcile pass', async () => {
    const img = addImage();
    const other = addImage();
    startObserver();
    onMediaObserved.mockClear();

    img.dispatchEvent(new Event('load'));
    other.dispatchEvent(new Event('load'));
    await flushMutationsAndReconcile();

    expect(onMediaObserved).toHaveBeenCalledTimes(1);
    expect(onMediaObserved).toHaveBeenCalledWith([img, other], []);
  });

  it('hears load events inside a shadow root present at start', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const img = document.createElement('img');
    img.src = 'https://example.com/shadow.jpg';
    shadow.appendChild(img);
    startObserver();

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
    onMediaObserved.mockClear();

    img.dispatchEvent(new Event('load'));
    await flushMutationsAndReconcile();

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('hears load events inside a late-attached shadow root', async () => {
    startObserver();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const img = document.createElement('img');
    img.src = 'https://example.com/late.jpg';
    shadow.appendChild(img);
    document.body.appendChild(host);
    await flushMutationsAndReconcile();
    onMediaObserved.mockClear();

    img.dispatchEvent(new Event('load'));
    await flushMutationsAndReconcile();

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('stops listening in a shadow root whose host was removed', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const img = document.createElement('img');
    img.src = 'https://example.com/gone.jpg';
    shadow.appendChild(img);
    startObserver();

    host.remove();
    await flushMutationsAndReconcile();
    onMediaObserved.mockClear();

    img.dispatchEvent(new Event('load'));
    await flushMutationsAndReconcile();

    expect(onMediaObserved).not.toHaveBeenCalled();
  });

  it('safety tick reconciles all tracked images even with no signal at all', async () => {
    vi.useFakeTimers();
    const img = addImage();
    startObserver({ safetyTickInterval: 2000 });
    onMediaObserved.mockClear();

    await vi.advanceTimersByTimeAsync(2000);

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('safety tick drops disconnected images from tracking', async () => {
    vi.useFakeTimers();
    const img = addImage();
    const survivor = addImage();
    startObserver({ safetyTickInterval: 2000 });
    img.remove();
    onMediaObserved.mockClear();

    await vi.advanceTimersByTimeAsync(2000);

    expect(onMediaObserved).toHaveBeenCalledWith([survivor], []);
  });

  it('markAllDirty marks all tracked images dirty', async () => {
    const img = addImage();
    startObserver();
    onMediaObserved.mockClear();

    observer.markAllDirty();
    await flushMutationsAndReconcile();

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('stops reconciling after stop()', async () => {
    const img = addImage();
    startObserver();
    observer.stop();
    onMediaObserved.mockClear();

    img.dispatchEvent(new Event('load'));
    await flushMutationsAndReconcile();

    expect(onMediaObserved).not.toHaveBeenCalled();
  });
});
