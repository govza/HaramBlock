// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageProcessor } from '@/entrypoints/content/core/ImageProcessor';
import {
  BLACKLIST_ATTR,
  BLUR_CLASS,
  PROCESSED_SAFE_ATTR,
  PROCESSED_SKIPPED_ATTR,
  PROCESSED_UNSAFE_ATTR,
} from '@/entrypoints/content/presentation/constants';

import type { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';
import type { IHostSettings, IImagePrediction } from '@/utils/types';

const requestImageInference = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@/entrypoints/content/communication/sender', () => ({
  requestImageInference,
  requestGifFrameInference: vi.fn(() => Promise.resolve()),
  requestToggleUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/entrypoints/content/presentation/quickToggle', () => ({
  initQuickToggle: vi.fn(),
  destroyQuickToggle: vi.fn(),
  registerQuickToggle: vi.fn(),
  unregisterQuickToggle: vi.fn(),
  predictionToggleRegistration: vi.fn(() => ({})),
}));
vi.mock('@/entrypoints/content/presentation/gifMaskPlayer', () => ({
  gifMaskPlayer: { hasPlayer: vi.fn(() => false), clearPlayer: vi.fn(), createOrUpdatePlayer: vi.fn() },
}));
vi.mock('@/entrypoints/content/presentation/imageMaskOverlay', () => ({
  imageMaskOverlay: { hasMaskOverlay: vi.fn(() => false), clearMaskOverlay: vi.fn() },
}));
vi.mock('@/entrypoints/content/presentation/predictionStyling', () => ({
  applyPredictionsStyling: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/entrypoints/content/gif/gifSupport', () => ({
  isGifCandidate: vi.fn(() => false),
}));
vi.mock('@/utils/logging', () => ({
  startContentTiming: vi.fn(),
  completeContentTiming: vi.fn(),
  cancelContentTiming: vi.fn(),
  markSent: vi.fn(),
  markReceived: vi.fn(),
}));
vi.mock('@/utils/messaging/content', () => ({
  waitForMessageChannel: vi.fn(() => Promise.resolve(true)),
}));

const SRC_SMALL = 'https://example.com/image-640.jpg';
const SRC_LARGE = 'https://example.com/image-1080.jpg';

const hostSettings = {
  hostname: 'example.com',
  policy: { behavior: 'process', targets: { image: true, gif: true, video: false } },
  minSize: { width: 0, height: 0 },
  masking: { blur: 20, grayscale: false },
} as unknown as IHostSettings;

const trackDetections = vi.fn();
const badgeCounter = { trackDetections, dispose: vi.fn() } as unknown as BadgeCounter;

const makePrediction = (src: string, detections = 0): IImagePrediction =>
  ({
    src,
    hostname: 'example.com',
    width: 100,
    height: 100,
    predictions: Array.from({ length: detections }, () => ({})),
    timestamp: 0,
    cacheMetadata: { createdAt: 0, accessedAt: 0 },
    maskTransform: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    processingTime: { fetchTime: 0, decodeTime: 0, queueTime: 0, inferenceTime: 0, e2eTime: 0, backend: 'wasm' },
    forcedVisibility: 'auto',
  }) as IImagePrediction;

interface ImageState {
  currentSrc: string;
  complete: boolean;
  naturalWidth: number;
}

const makeImage = (state: ImageState): { img: HTMLImageElement; state: ImageState } => {
  const img = document.createElement('img');
  Object.defineProperty(img, 'currentSrc', { get: () => state.currentSrc });
  Object.defineProperty(img, 'complete', { get: () => state.complete });
  Object.defineProperty(img, 'naturalWidth', { get: () => state.naturalWidth });
  Object.defineProperty(img, 'clientWidth', { get: () => 300 });
  Object.defineProperty(img, 'clientHeight', { get: () => 300 });
  document.body.appendChild(img);
  return { img, state };
};

const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve));

describe('ImageProcessor reconcile convergence', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  it('keeps an unloaded image blurred without sending inference or attaching listeners', () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    const { img } = makeImage({ currentSrc: SRC_SMALL, complete: false, naturalWidth: 0 });
    const addEventListener = vi.spyOn(img, 'addEventListener');

    processor.process(img);

    expect(img.classList.contains(BLUR_CLASS)).toBe(true);
    expect(requestImageInference).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('converges an orphaned deferrer to the cached verdict on the next reconcile pass', async () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);

    const owner = makeImage({ currentSrc: SRC_SMALL, complete: true, naturalWidth: 640 });
    processor.process(owner.img);
    await flushAsync();
    expect(requestImageInference).toHaveBeenCalledTimes(1);

    const deferrer = makeImage({ currentSrc: SRC_SMALL, complete: false, naturalWidth: 0 });
    processor.process(deferrer.img);
    expect(deferrer.img.classList.contains(BLUR_CLASS)).toBe(true);

    owner.state.currentSrc = SRC_LARGE;
    processor.handleInferenceResults([{ status: 'ok', prediction: makePrediction(SRC_LARGE) }]);

    vi.useFakeTimers();
    deferrer.state.currentSrc = SRC_LARGE;
    deferrer.state.complete = true;
    deferrer.state.naturalWidth = 1080;
    processor.process(deferrer.img);
    expect(deferrer.img.classList.contains(BLUR_CLASS)).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();

    expect(deferrer.img.hasAttribute(PROCESSED_SAFE_ATTR)).toBe(true);
    expect(deferrer.img.classList.contains(BLUR_CLASS)).toBe(false);
  });

  it('applies an unsafe cached verdict to a swept image and keeps it protected', async () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    processor.handleInferenceResults([{ status: 'ok', prediction: makePrediction(SRC_LARGE, 1) }]);

    const { img } = makeImage({ currentSrc: SRC_LARGE, complete: true, naturalWidth: 1080 });
    processor.process(img);
    await flushAsync();

    expect(img.hasAttribute(PROCESSED_UNSAFE_ATTR)).toBe(true);
    expect(requestImageInference).not.toHaveBeenCalled();
  });

  it('fails open on an image the browser gave up on (complete with no pixels)', () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    const { img } = makeImage({ currentSrc: SRC_SMALL, complete: true, naturalWidth: 0 });

    processor.process(img);

    expect(img.classList.contains(BLUR_CLASS)).toBe(false);
    expect(requestImageInference).not.toHaveBeenCalled();
  });

  it('re-reconciling an unsafe image the user forced visible is a no-op', async () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    const prediction = { ...makePrediction(SRC_LARGE, 1), forcedVisibility: 'visible' as const };
    processor.handleInferenceResults([{ status: 'ok', prediction }]);
    const { img } = makeImage({ currentSrc: SRC_LARGE, complete: true, naturalWidth: 1080 });
    processor.process(img);
    await flushAsync();
    expect(img.hasAttribute(PROCESSED_UNSAFE_ATTR)).toBe(true);
    trackDetections.mockClear();

    processor.process(img);
    await flushAsync();

    expect(trackDetections).not.toHaveBeenCalled();
  });

  it('routes a source replacement through invalidation instead of trusting the old processed status', async () => {
    vi.useFakeTimers();
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    processor.handleInferenceResults([{ status: 'ok', prediction: makePrediction(SRC_SMALL) }]);
    const { img, state } = makeImage({ currentSrc: SRC_SMALL, complete: true, naturalWidth: 640 });
    processor.process(img);
    await vi.advanceTimersByTimeAsync(0);
    expect(img.hasAttribute(PROCESSED_SAFE_ATTR)).toBe(true);

    state.currentSrc = SRC_LARGE;
    processor.process(img);

    expect(img.hasAttribute(PROCESSED_SAFE_ATTR)).toBe(false);
    expect(img.classList.contains(BLUR_CLASS)).toBe(true);

    await vi.advanceTimersByTimeAsync(200);
    expect(requestImageInference).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('falls back to a whole-frame blur when the mask overlay cannot be anchored, then converges', async () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    processor.handleInferenceResults([{ status: 'ok', prediction: makePrediction(SRC_LARGE, 1) }]);
    const { img } = makeImage({ currentSrc: SRC_LARGE, complete: true, naturalWidth: 1080 });

    processor.process(img);
    await flushAsync();

    expect(img.hasAttribute(PROCESSED_UNSAFE_ATTR)).toBe(true);
    expect(img.hasAttribute(BLACKLIST_ATTR)).toBe(true);
    trackDetections.mockClear();

    processor.process(img);
    await flushAsync();
    expect(trackDetections).not.toHaveBeenCalled();
  });

  it('failing open on a broken copy leaves a still-loading sibling protected', () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    const sibling = makeImage({ currentSrc: SRC_SMALL, complete: false, naturalWidth: 0 });
    processor.process(sibling.img);
    expect(sibling.img.classList.contains(BLUR_CLASS)).toBe(true);

    const broken = makeImage({ currentSrc: SRC_SMALL, complete: true, naturalWidth: 0 });
    processor.process(broken.img);

    expect(broken.img.hasAttribute(PROCESSED_SKIPPED_ATTR)).toBe(true);
    expect(sibling.img.classList.contains(BLUR_CLASS)).toBe(true);
    expect(sibling.img.hasAttribute(PROCESSED_SKIPPED_ATTR)).toBe(false);
  });

  it('converges a broken copy that has a cached verdict instead of re-entering forever', async () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    processor.handleInferenceResults([{ status: 'ok', prediction: makePrediction(SRC_SMALL) }]);
    const { img } = makeImage({ currentSrc: SRC_SMALL, complete: true, naturalWidth: 0 });

    processor.process(img);
    await flushAsync();

    expect(img.hasAttribute(PROCESSED_SKIPPED_ATTR)).toBe(true);
    trackDetections.mockClear();

    processor.process(img);
    await flushAsync();
    expect(trackDetections).not.toHaveBeenCalled();
  });

  it('re-reconciling a finalized image is a no-op (no overlay churn)', async () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    processor.handleInferenceResults([{ status: 'ok', prediction: makePrediction(SRC_LARGE) }]);
    const { img } = makeImage({ currentSrc: SRC_LARGE, complete: true, naturalWidth: 1080 });
    processor.process(img);
    await flushAsync();
    expect(img.hasAttribute(PROCESSED_SAFE_ATTR)).toBe(true);
    trackDetections.mockClear();

    processor.process(img);
    await flushAsync();

    expect(trackDetections).not.toHaveBeenCalled();
    expect(img.hasAttribute(PROCESSED_SAFE_ATTR)).toBe(true);
  });
});
