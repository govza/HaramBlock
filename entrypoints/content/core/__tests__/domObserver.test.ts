// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DomObserver, type DomObserverConfig } from '@/entrypoints/content/core/DomObserver';
import { notifySrcDrift } from '@/entrypoints/content/presentation/srcDrift';

const flushMutationsAndReconcile = () => new Promise<void>(resolve => setTimeout(resolve));

describe('DomObserver reconciliation pass', () => {
  let observer: DomObserver;
  let onMediaObserved: ReturnType<typeof vi.fn<DomObserverConfig['onMediaObserved']>>;

  const startObserver = (config: Partial<DomObserverConfig> = {}): DomObserver => {
    observer = new DomObserver({
      onMediaObserved,
      onMediaRemoved: vi.fn(),
      onVideoAttributesChanged: vi.fn(),
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

  it('observes mutations inside a shadow root attached after the host was seen', async () => {
    vi.useFakeTimers();
    const lazyHost = document.createElement('lazy-widget');
    document.body.appendChild(lazyHost);
    startObserver();
    onMediaObserved.mockClear();

    const shadow = lazyHost.attachShadow({ mode: 'open' });
    await vi.advanceTimersByTimeAsync(250);
    const img = document.createElement('img');
    img.src = 'https://example.com/lazy-added.jpg';
    shadow.appendChild(img);
    await vi.advanceTimersByTimeAsync(0);

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('reports media inside nested shadow roots when their host is removed', async () => {
    const onMediaRemoved = vi.fn<DomObserverConfig['onMediaRemoved']>();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('div');
    shadow.appendChild(innerHost);
    const innerShadow = innerHost.attachShadow({ mode: 'open' });
    const img = document.createElement('img');
    img.src = 'https://example.com/nested-removed.jpg';
    innerShadow.appendChild(img);
    startObserver({ onMediaRemoved });

    host.remove();
    await flushMutationsAndReconcile();

    expect(onMediaRemoved).toHaveBeenCalledWith([img], []);
  });

  it('safety tick reconciles all tracked images even with no signal at all', async () => {
    vi.useFakeTimers();
    const img = addImage();
    startObserver({ safetyTickIntervalMs: 2000 });
    onMediaObserved.mockClear();

    await vi.advanceTimersByTimeAsync(2000);

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('safety tick prunes disconnected images and reports them removed', async () => {
    vi.useFakeTimers();
    const onMediaRemoved = vi.fn<DomObserverConfig['onMediaRemoved']>();
    const img = addImage();
    const survivor = addImage();
    startObserver({ safetyTickIntervalMs: 2000, onMediaRemoved });
    img.remove();
    onMediaObserved.mockClear();
    onMediaRemoved.mockClear();

    await vi.advanceTimersByTimeAsync(2000);

    expect(onMediaObserved).toHaveBeenCalledWith([survivor], []);
    expect(onMediaRemoved).toHaveBeenCalledWith([img], []);
  });

  it('prunes a disconnected dirty image during a reconcile pass and reports it removed', async () => {
    const onMediaRemoved = vi.fn<DomObserverConfig['onMediaRemoved']>();
    const img = addImage();
    startObserver({ onMediaRemoved });
    onMediaObserved.mockClear();
    onMediaRemoved.mockClear();

    img.dispatchEvent(new Event('load'));
    img.remove();
    await flushMutationsAndReconcile();

    expect(onMediaObserved).not.toHaveBeenCalled();
    expect(onMediaRemoved).toHaveBeenCalledWith([img], []);
  });

  it('a src-drift notification marks the image dirty and reconciles it', async () => {
    const img = addImage();
    startObserver();
    onMediaObserved.mockClear();

    notifySrcDrift(img);
    await flushMutationsAndReconcile();

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('ignores src-drift notifications after stop()', async () => {
    const img = addImage();
    startObserver();
    observer.stop();
    onMediaObserved.mockClear();

    notifySrcDrift(img);
    await flushMutationsAndReconcile();

    expect(onMediaObserved).not.toHaveBeenCalled();
  });

  it('an image attribute change enters as a dirty hint and reconciles', async () => {
    const img = addImage();
    startObserver();
    onMediaObserved.mockClear();

    img.setAttribute('src', 'https://example.com/b.jpg');
    await flushMutationsAndReconcile();

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('a video attribute change is reported through onVideoAttributesChanged', async () => {
    const onVideoAttributesChanged = vi.fn<DomObserverConfig['onVideoAttributesChanged']>();
    const video = document.createElement('video');
    video.src = 'https://example.com/a.mp4';
    document.body.appendChild(video);
    startObserver({ onVideoAttributesChanged });
    onVideoAttributesChanged.mockClear();

    video.setAttribute('src', 'https://example.com/b.mp4');
    await flushMutationsAndReconcile();

    expect(onVideoAttributesChanged).toHaveBeenCalledWith([video]);
  });

  describe('findTrackedImagesBySrc', () => {
    it('finds tracked images sharing a resolved src, including inside shadow roots', () => {
      const light = addImage();
      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      const shadowImg = document.createElement('img');
      shadowImg.src = 'https://example.com/a.jpg';
      shadow.appendChild(shadowImg);
      const other = document.createElement('img');
      other.src = 'https://example.com/other.jpg';
      document.body.appendChild(other);
      startObserver();

      expect(observer.findTrackedImagesBySrc('https://example.com/a.jpg')).toEqual([light, shadowImg]);
    });

    it('omits disconnected images', () => {
      const img = addImage();
      startObserver();

      img.remove();

      expect(observer.findTrackedImagesBySrc('https://example.com/a.jpg')).toEqual([]);
    });
  });

  it('does not track videos: markAllDirty never re-reports them', async () => {
    const video = document.createElement('video');
    video.src = 'https://example.com/a.mp4';
    document.body.appendChild(video);
    startObserver();
    onMediaObserved.mockClear();

    observer.markAllDirty();
    await flushMutationsAndReconcile();

    expect(onMediaObserved).not.toHaveBeenCalled();
  });

  it('markAllDirty marks all tracked images dirty after the coalescing window', async () => {
    vi.useFakeTimers();
    const img = addImage();
    startObserver();
    onMediaObserved.mockClear();

    observer.markAllDirty();
    await vi.advanceTimersByTimeAsync(100);

    expect(onMediaObserved).toHaveBeenCalledWith([img], []);
  });

  it('coalesces a burst of markAllDirty calls into one reconcile pass', async () => {
    vi.useFakeTimers();
    addImage();
    startObserver();
    onMediaObserved.mockClear();

    for (let i = 0; i < 5; i++) {
      observer.markAllDirty();
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(onMediaObserved).toHaveBeenCalledTimes(1);
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
