// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageProcessor } from '@/entrypoints/content/core/ImageProcessor';
import {
  BLACKLIST_ATTR,
  BLUR_CLASS,
  PROCESSED_SAFE_ATTR,
  PROCESSED_UNSAFE_ATTR,
} from '@/entrypoints/content/presentation/constants';
import { DEFAULT_HOST_SETTINGS } from '@/utils/constants/hostsettings';

import type { BadgeCounter } from '@/entrypoints/content/core/BadgeCounter';
import type { IImagePrediction } from '@/utils/types';

const { applyPredictionsStyling } = vi.hoisted(() => ({
  applyPredictionsStyling: vi.fn((): Promise<void> => Promise.resolve()),
}));

vi.mock('@/entrypoints/content/communication/sender', () => ({
  requestImageInference: vi.fn(() => Promise.resolve()),
  requestToggleUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/entrypoints/content/presentation/predictionStyling', () => ({ applyPredictionsStyling }));
vi.mock('@/entrypoints/content/presentation/quickToggle', () => ({
  initQuickToggle: vi.fn(),
  destroyQuickToggle: vi.fn(),
  predictionToggleRegistration: vi.fn(() => ({})),
  registerQuickToggle: vi.fn(),
  unregisterQuickToggle: vi.fn(),
}));
vi.mock('@/utils/messaging/content', () => ({ waitForMessageChannel: vi.fn(() => Promise.resolve()) }));

class FakeIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const SRC = 'https://cdn.test/unsafe.jpg';

const loadedImage = (): HTMLImageElement => {
  const img = document.createElement('img');
  img.src = SRC;
  Object.defineProperty(img, 'complete', { value: true });
  Object.defineProperty(img, 'naturalWidth', { value: 200 });
  Object.defineProperty(img, 'naturalHeight', { value: 200 });
  document.body.append(img);
  return img;
};

const unsafePrediction = (forcedVisibility: IImagePrediction['forcedVisibility']): IImagePrediction =>
  ({
    src: SRC,
    hostname: 'example.com',
    width: 200,
    height: 200,
    predictions: [{}],
    timestamp: 0,
    forcedVisibility,
  }) as unknown as IImagePrediction;

const hostSettings = { ...DEFAULT_HOST_SETTINGS, hostname: 'example.com' };
const badgeCounter = { trackDetections: vi.fn() } as unknown as BadgeCounter;

const presentedProcessor = async (forcedVisibility: IImagePrediction['forcedVisibility']) => {
  const processor = new ImageProcessor(hostSettings, badgeCounter);
  const img = loadedImage();
  processor.seedCache([unsafePrediction(forcedVisibility)]);
  processor.process(img);
  await vi.advanceTimersByTimeAsync(0);
  return { processor, img };
};

describe('ImageProcessor verdict presentation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    document.body.innerHTML = '';
    applyPredictionsStyling.mockReset();
    applyPredictionsStyling.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the protective blur while the mask overlay paints after a toggle back to auto', async () => {
    const { processor, img } = await presentedProcessor('blocked');
    expect(img.hasAttribute(BLACKLIST_ATTR)).toBe(true);

    let paintOverlay = (): void => {};
    applyPredictionsStyling.mockReturnValue(
      new Promise<void>(resolve => {
        paintOverlay = resolve;
      }),
    );
    processor.toggleImage(SRC, 'auto');
    expect(img.classList.contains(BLUR_CLASS)).toBe(true);

    paintOverlay();
    await vi.advanceTimersByTimeAsync(0);
    expect(img.classList.contains(BLUR_CLASS)).toBe(false);
    expect(img.hasAttribute(PROCESSED_UNSAFE_ATTR)).toBe(true);
  });

  it('blocks synchronously and keeps the processed status when toggled to blocked', async () => {
    const { processor, img } = await presentedProcessor('visible');
    expect(img.hasAttribute(PROCESSED_UNSAFE_ATTR)).toBe(true);

    processor.toggleImage(SRC, 'blocked');
    expect(img.hasAttribute(BLACKLIST_ATTR)).toBe(true);
    expect(img.hasAttribute(PROCESSED_UNSAFE_ATTR)).toBe(true);
    expect(img.hasAttribute(PROCESSED_SAFE_ATTR)).toBe(false);
  });

  it('reveals a toggled-visible image with its processed status intact', async () => {
    const { processor, img } = await presentedProcessor('blocked');

    processor.toggleImage(SRC, 'visible');
    expect(img.hasAttribute(BLACKLIST_ATTR)).toBe(false);
    expect(img.classList.contains(BLUR_CLASS)).toBe(false);
    expect(img.hasAttribute(PROCESSED_UNSAFE_ATTR)).toBe(true);
  });
});
