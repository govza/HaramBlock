// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageProcessor } from '@/entrypoints/content/core/ImageProcessor';
import { IMAGE_INFERENCE_TIMEOUT_MS, IMAGE_QUEUE_WAIT_TIMEOUT_MS } from '@/entrypoints/content/core/inferenceTracker';
import { BLUR_CLASS, PROCESSED_SKIPPED_ATTR } from '@/entrypoints/content/presentation/constants';
import { DEFAULT_HOST_SETTINGS } from '@/utils/constants/hostsettings';

import type { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';

const { requestImageInference } = vi.hoisted(() => ({
  requestImageInference: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/entrypoints/content/communication/sender', () => ({ requestImageInference }));
vi.mock('@/entrypoints/content/presentation/quickToggle', () => ({
  initQuickToggle: vi.fn(),
  ensureQuickToggleButton: vi.fn(),
  removeQuickToggleButton: vi.fn(),
  hideQuickToggleButton: vi.fn(),
}));
vi.mock('@/utils/messaging/content', () => ({ waitForMessageChannel: vi.fn(() => Promise.resolve()) }));

class FakeIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const loadedImage = (src: string): HTMLImageElement => {
  const img = document.createElement('img');
  img.src = src;
  Object.defineProperty(img, 'complete', { value: true });
  Object.defineProperty(img, 'naturalWidth', { value: 200 });
  Object.defineProperty(img, 'naturalHeight', { value: 200 });
  document.body.append(img);
  return img;
};

const hostSettings = { ...DEFAULT_HOST_SETTINGS, hostname: 'example.com' };
const badgeCounter = { trackDetections: vi.fn() } as unknown as BadgeCounter;

describe('ImageProcessor inference failure handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries after the queue-wait guard, then keeps the blur instead of revealing', async () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    const img = loadedImage('https://cdn.test/a.jpg');
    processor.process(img);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestImageInference).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IMAGE_INFERENCE_TIMEOUT_MS);
    expect(requestImageInference).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IMAGE_QUEUE_WAIT_TIMEOUT_MS - IMAGE_INFERENCE_TIMEOUT_MS);
    expect(requestImageInference).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(IMAGE_QUEUE_WAIT_TIMEOUT_MS);
    expect(requestImageInference).toHaveBeenCalledTimes(2);
    expect(img.classList.contains(BLUR_CLASS)).toBe(true);
    expect(img.hasAttribute(PROCESSED_SKIPPED_ATTR)).toBe(false);
  });

  it('fails open after repeated explicit inference errors', async () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    const img = loadedImage('https://cdn.test/c.jpg');
    processor.process(img);
    await vi.advanceTimersByTimeAsync(0);

    const error = { status: 'error' as const, src: img.src, hostname: 'example.com', reason: 'decode failed' };
    processor.handleInferenceResults([error]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestImageInference).toHaveBeenCalledTimes(2);

    processor.handleInferenceResults([error]);
    expect(img.classList.contains(BLUR_CLASS)).toBe(false);
    expect(img.hasAttribute(PROCESSED_SKIPPED_ATTR)).toBe(true);
  });

  it('skips a decoded placeholder without sending it for inference', async () => {
    const processor = new ImageProcessor(hostSettings, badgeCounter);
    const img = document.createElement('img');
    img.src = 'https://cdn.test/placeholder.jpg';
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: 10 });
    Object.defineProperty(img, 'naturalHeight', { value: 13 });
    Object.defineProperty(img, 'clientWidth', { value: 300 });
    Object.defineProperty(img, 'clientHeight', { value: 300 });
    document.body.append(img);

    processor.process(img);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestImageInference).not.toHaveBeenCalled();
    expect(img.hasAttribute(PROCESSED_SKIPPED_ATTR)).toBe(true);
  });
});
