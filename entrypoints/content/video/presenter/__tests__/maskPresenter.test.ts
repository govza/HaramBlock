// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VIDEO_MASK_OVERLAY_ATTR } from '@/entrypoints/content/presentation/constants';
import { MaskPresenter } from '@/entrypoints/content/video/presenter/maskPresenter';

import type { VerdictInterpreter, VerdictLookup } from '@/entrypoints/content/video/timeline/verdictInterpreter';
import type { VerdictEntry } from '@/entrypoints/content/video/timeline/verdictTimeline';

const UNSAFE: VerdictEntry = {
  timestampSec: 0,
  unsafe: true,
  width: 2,
  height: 2,
  maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
  predictions: [],
};

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

function placeAt(element: HTMLElement, box: DOMRect): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(box);
}

let frames: FrameRequestCallback[] = [];
let lookup: VerdictLookup = { kind: 'unsafe', entries: [UNSAFE] };

function renderFrame(): void {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame(performance.now());
}

function mount(prepareVideo: (video: HTMLVideoElement) => void = () => {}, pagePixelsReadable = true) {
  const container = document.createElement('div');
  const video = document.createElement('video');
  prepareVideo(video);
  container.appendChild(video);
  document.body.appendChild(container);
  placeAt(container, rect(0, 0, 800, 600));
  placeAt(video, rect(10, 20, 640, 360));
  const presenter = new MaskPresenter({
    video,
    interpreter: { verdictFor: () => lookup } as unknown as VerdictInterpreter,
    verdictOptions: () => ({}),
    masking: () => ({ blurIntensity: 50, pixelationScale: 0, grayscale: false, dark: false }),
    pagePixelsReadable,
    onPresented: () => {},
    onFrame: () => {},
  });
  presenter.start();
  return { container, video, presenter };
}

const overlayOf = (root: ParentNode) => root.querySelector<HTMLElement>(`[${VIDEO_MASK_OVERLAY_ATTR}]`);

const setFullscreenElement = (element: Element | null) =>
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });

beforeEach(() => {
  frames = [];
  lookup = { kind: 'unsafe', entries: [UNSAFE] };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  setFullscreenElement(null);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Mask Presenter geometry', () => {
  it('covers the video box with an overlay next to the video', () => {
    const { video } = mount();
    renderFrame();

    const overlay = overlayOf(document);
    expect(overlay?.previousElementSibling).toBe(video);
    expect(overlay?.style).toMatchObject({
      display: 'block',
      top: '20px',
      left: '10px',
      width: '640px',
      height: '360px',
    });
  });

  it('follows the video when it is resized', () => {
    const { video } = mount();
    renderFrame();
    placeAt(video, rect(10, 20, 320, 180));
    renderFrame();

    expect(overlayOf(document)?.style).toMatchObject({ width: '320px', height: '180px' });
  });

  it('moves with the video when it is re-parented', () => {
    const { video } = mount();
    renderFrame();
    const player = document.createElement('section');
    document.body.appendChild(player);
    placeAt(player, rect(100, 100, 800, 600));
    player.appendChild(video);
    placeAt(video, rect(100, 150, 640, 360));
    renderFrame();

    const overlay = overlayOf(player);
    expect(overlay?.previousElementSibling).toBe(video);
    expect(overlay?.style).toMatchObject({ top: '50px', left: '0px' });
  });

  it('masks the whole video itself while the video is in native fullscreen, where overlays cannot render', () => {
    const { video } = mount();
    setFullscreenElement(video);
    renderFrame();

    expect(video.style.getPropertyValue('filter')).toContain('blur');
    expect(overlayOf(document)?.style.display ?? 'none').toBe('none');
  });

  it('restores the video and returns to the overlay when fullscreen ends', () => {
    const { video } = mount();
    video.style.filter = 'contrast(1.1)';
    setFullscreenElement(video);
    renderFrame();
    setFullscreenElement(null);
    renderFrame();

    expect(video.style.getPropertyValue('filter')).toBe('contrast(1.1)');
    expect(overlayOf(document)?.style.display).toBe('block');
  });

  it('lifts the fullscreen mask when the unsafe span ends', () => {
    const { video } = mount();
    setFullscreenElement(video);
    renderFrame();
    lookup = { kind: 'clean' };
    renderFrame();

    expect(video.style.getPropertyValue('filter')).toBe('');
  });

  it('keeps the overlay when a player container, not the video, is fullscreen', () => {
    const { container, video } = mount();
    setFullscreenElement(container);
    renderFrame();

    expect(video.style.getPropertyValue('filter')).toBe('');
    expect(overlayOf(container)?.style.display).toBe('block');
  });
});

describe('Mask Presenter effect', () => {
  const canvasOf = (root: ParentNode) => overlayOf(root)?.querySelector('canvas') ?? null;

  function withDecodedFrame(video: HTMLVideoElement) {
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 360 });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
      imageSmoothingEnabled: false,
    } as unknown as GPUCanvasContext);
    return drawImage;
  }

  function stubVideoFrameCallbacks(video: HTMLVideoElement) {
    let pending: VideoFrameRequestCallback | null = null;
    video.requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
      pending = callback;
      return 1;
    });
    video.cancelVideoFrameCallback = vi.fn();
    return () => pending?.(performance.now(), {} as VideoFrameCallbackMetadata);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pixelates the masked region into blocks drawn from the playing video', () => {
    const { video } = mount();
    const drawImage = withDecodedFrame(video);
    renderFrame();

    const canvas = canvasOf(document);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, canvas?.width, canvas?.height);
    expect(canvas?.width).toBe(80);
    expect(canvas?.height).toBe(45);
    expect(canvas?.style.display).toBe('block');
    expect(overlayOf(document)?.style.getPropertyValue('backdrop-filter')).toBe('');
  });

  it('redraws the blocks only when the video presents a new frame', () => {
    const { video } = mount();
    const drawImage = withDecodedFrame(video);
    const presentFrame = stubVideoFrameCallbacks(video);
    renderFrame();
    renderFrame();
    expect(drawImage).toHaveBeenCalledTimes(1);

    presentFrame();
    renderFrame();
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('stops watching presented frames once the mask lifts', () => {
    const { video } = mount();
    withDecodedFrame(video);
    const cancel = vi.fn();
    stubVideoFrameCallbacks(video);
    video.cancelVideoFrameCallback = cancel;
    renderFrame();
    lookup = { kind: 'clean' };
    renderFrame();

    expect(cancel).toHaveBeenCalled();
  });

  it('blurs instead of pixelating when page pixels are unreadable (lookahead-only)', () => {
    const { video } = mount(() => {}, false);
    const drawImage = withDecodedFrame(video);
    renderFrame();

    expect(drawImage).not.toHaveBeenCalled();
    expect(canvasOf(document)?.style.display).not.toBe('block');
    expect(overlayOf(document)?.style.getPropertyValue('backdrop-filter')).toContain('blur');
  });

  it('blurs the masked region while the video has no decoded frame to pixelate', () => {
    mount();
    renderFrame();

    expect(canvasOf(document)?.style.display).toBe('none');
    expect(overlayOf(document)?.style.getPropertyValue('backdrop-filter')).toContain('blur');
  });
});

describe('Mask Presenter thumbnail', () => {
  it('masks with the unsafe thumbnail before playback starts', () => {
    lookup = { kind: 'none' };
    const { presenter } = mount();
    presenter.setThumbnail(UNSAFE);
    renderFrame();

    expect(overlayOf(document)?.style.display).toBe('block');
  });

  it('ignores the thumbnail when attached to a video that is already playing', () => {
    lookup = { kind: 'none' };
    const { presenter } = mount(video => Object.defineProperty(video, 'paused', { configurable: true, value: false }));
    presenter.setThumbnail(UNSAFE);
    renderFrame();

    expect(overlayOf(document)?.style.display ?? 'none').toBe('none');
  });
});
