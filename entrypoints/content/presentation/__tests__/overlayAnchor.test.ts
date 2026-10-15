// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { anchorOverlay, type AnchorOptions } from '@/entrypoints/content/presentation/overlayAnchor';
import { setSrcDriftHandler } from '@/entrypoints/content/presentation/srcDrift';

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

const placeAt = (element: HTMLElement, box: DOMRect): void => {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(box);
};

let frames: FrameRequestCallback[] = [];

const renderFrame = (): void => {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame(performance.now());
};

const renderFrames = (count: number): void => {
  for (let i = 0; i < count; i++) renderFrame();
};

const flushMutations = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const mountImage = (parent: ParentNode = document.body) => {
  const container = document.createElement('div');
  const image = document.createElement('img');
  image.src = 'https://example.test/a.jpg';
  container.appendChild(image);
  parent.appendChild(container);
  placeAt(container, rect(100, 50, 800, 600));
  placeAt(image, rect(110, 70, 400, 300));
  return { container, image };
};

const anchor = (element: HTMLImageElement | HTMLVideoElement, options: Partial<AnchorOptions> = {}) => {
  const overlay = document.createElement('div');
  const onLayout = vi.fn();
  const onLost = vi.fn();
  const handle = anchorOverlay(element, overlay, { onLayout, onLost, ...options });
  return { overlay, onLayout, onLost, handle };
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  setSrcDriftHandler(null);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('overlay anchor placement', () => {
  it('covers the element box as its next sibling, positioned inside the parent', () => {
    const { image } = mountImage();
    const { overlay, onLayout, handle } = anchor(image);

    const geometry = handle.refresh();

    expect(overlay.previousElementSibling).toBe(image);
    expect(overlay.style).toMatchObject({
      position: 'absolute',
      top: '20px',
      left: '10px',
      width: '400px',
      height: '300px',
    });
    expect(onLayout).toHaveBeenCalledWith(geometry);
    expect(geometry).toMatchObject({ top: 20, left: 10, width: 400, height: 300 });
  });

  it('places nothing until the first refresh', () => {
    const { image } = mountImage();
    const { overlay } = anchor(image);

    expect(overlay.isConnected).toBe(false);
  });

  it('appends a badge into the container above the element without sizing it', () => {
    const { container, image } = mountImage();
    image.style.zIndex = '3';
    const { overlay, handle } = anchor(image, { stacking: 'badge' });

    handle.refresh();

    expect(overlay.parentNode).toBe(container);
    expect(container.lastElementChild).toBe(overlay);
    expect(overlay.style.zIndex).toBe('5');
    expect(overlay.style.width).toBe('');
  });

  it('homes inside the shadow root of an element that is a direct shadow child, against the host box', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const video = document.createElement('video');
    shadow.appendChild(video);
    placeAt(host, rect(0, 0, 800, 600));
    placeAt(video, rect(30, 40, 640, 360));
    const { overlay, handle } = anchor(video);

    handle.refresh();

    expect(overlay.parentNode).toBe(shadow);
    expect(overlay.previousElementSibling).toBe(video);
    expect(overlay.style).toMatchObject({ top: '40px', left: '30px' });
  });
});

describe('overlay anchor re-homing', () => {
  it('follows the element when a re-render moves it to another parent', async () => {
    const { image } = mountImage();
    const { overlay, handle } = anchor(image);
    handle.refresh();

    const next = document.createElement('section');
    document.body.appendChild(next);
    placeAt(next, rect(0, 0, 800, 600));
    next.appendChild(image);
    placeAt(image, rect(0, 200, 400, 300));
    await flushMutations();
    renderFrame();

    expect(overlay.parentNode).toBe(next);
    expect(overlay.previousElementSibling).toBe(image);
    expect(overlay.style.top).toBe('200px');
  });

  it('puts the overlay back when the site removes it while the element stays', async () => {
    const { image } = mountImage();
    const { overlay, handle } = anchor(image);
    handle.refresh();

    overlay.remove();
    await flushMutations();

    expect(overlay.previousElementSibling).toBe(image);
  });

  it('follows viewport scroll', () => {
    const { image } = mountImage();
    const { overlay, handle } = anchor(image);
    handle.refresh();

    placeAt(image, rect(110, 90, 400, 300));
    globalThis.dispatchEvent(new Event('scroll'));
    renderFrame();

    expect(overlay.style.top).toBe('40px');
  });
});

describe('overlay anchor detachment', () => {
  it('waits for a not-yet-attached element and places the overlay once it connects', () => {
    const image = document.createElement('img');
    const { overlay, onLayout, onLost, handle } = anchor(image);

    expect(handle.refresh()).toBeNull();
    renderFrames(5);
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.appendChild(image);
    renderFrame();

    expect(overlay.previousElementSibling).toBe(image);
    expect(onLayout).toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });

  it('takes the overlay down while the element is detached and restores it when it returns', async () => {
    const { container, image } = mountImage();
    const { overlay, onLost, handle } = anchor(image);
    handle.refresh();

    image.remove();
    await flushMutations();
    expect(overlay.isConnected).toBe(false);

    renderFrames(3);
    container.appendChild(image);
    renderFrame();

    expect(overlay.previousElementSibling).toBe(image);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('gives up on an element that never returns', async () => {
    const { image } = mountImage();
    const { overlay, onLost, onLayout, handle } = anchor(image);
    handle.refresh();

    image.remove();
    await flushMutations();
    renderFrames(40);

    expect(onLost).toHaveBeenCalledExactlyOnceWith('detached');
    expect(overlay.isConnected).toBe(false);
    onLayout.mockClear();
    expect(handle.refresh()).toBeNull();
    expect(onLayout).not.toHaveBeenCalled();
  });
});

describe('overlay anchor source drift', () => {
  it('ends the overlay and reports the drift when a tracked image changes source', () => {
    const drift = vi.fn();
    setSrcDriftHandler(drift);
    const { image } = mountImage();
    const { overlay, onLost, handle } = anchor(image, { trackSrc: true });
    handle.refresh();

    image.src = 'https://example.test/b.jpg';

    expect(handle.refresh()).toBeNull();
    expect(onLost).toHaveBeenCalledExactlyOnceWith('src-drift');
    expect(drift).toHaveBeenCalledExactlyOnceWith(image);
    expect(overlay.isConnected).toBe(false);
  });

  it('ignores source changes when not tracking', () => {
    const { image } = mountImage();
    const { onLost, handle } = anchor(image);
    handle.refresh();

    image.src = 'https://example.test/b.jpg';

    expect(handle.refresh()).not.toBeNull();
    expect(onLost).not.toHaveBeenCalled();
  });
});

describe('overlay anchor disposal', () => {
  it('removes the overlay and stops following the element', async () => {
    const { image } = mountImage();
    const { overlay, onLayout, handle } = anchor(image);
    handle.refresh();

    handle.dispose();
    onLayout.mockClear();
    document.body.appendChild(image);
    globalThis.dispatchEvent(new Event('resize'));
    await flushMutations();
    renderFrame();

    expect(overlay.isConnected).toBe(false);
    expect(handle.refresh()).toBeNull();
    expect(onLayout).not.toHaveBeenCalled();
  });
});
