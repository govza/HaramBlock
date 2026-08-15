import { When, Then } from '@wdio/cucumber-framework';

import { buildGalleryUrl, GalleryMode, Selectors, type GallerySizeType } from '../constants/index.js';
import { isMobile } from '../utils/platform.js';

const getElementCount = async (selector: string): Promise<number> => {
  const elements = await $$(selector);
  return elements.length;
};

const waitForCount = async (getCount: () => Promise<number>, expected: number, label: string): Promise<number> => {
  let actual = await getCount();
  await browser.waitUntil(
    async () => {
      actual = await getCount();
      return actual === expected;
    },
    {
      timeout: 10000,
      timeoutMsg: `Expected ${expected} ${label} but found ${actual}`,
    },
  );
  return actual;
};

const scrollToLoadAllImages = async (): Promise<void> => {
  const footer = await $('footer');
  await footer.waitForExist({ timeout: 5000 });
  await footer.scrollIntoView({ block: 'end' });
};

const openBasicGallery = async (
  count: string,
  size: string,
  options: { mode?: string; absolute?: boolean } = {},
): Promise<void> => {
  const url = buildGalleryUrl({
    ...(options.mode !== undefined && { mode: options.mode === 'safe' ? GalleryMode.SAFE : GalleryMode.NOT_SAFE }),
    count: parseInt(count, 10),
    size: size as GallerySizeType,
    overlay: !isMobile(), // overlay hijacks taps on mobile (no hover)
    absolute: options.absolute ?? false,
  });
  await browser.url(url);
  await scrollToLoadAllImages();
  const expectedCount = parseInt(count, 10);
  await browser.waitUntil(async () => (await getElementCount(Selectors.GALLERY_IMAGE)) >= expectedCount, {
    timeout: 10000,
    timeoutMsg: `Expected ${count} images to load`,
  });
};

When('I go to the basic gallery with {string} {string} images', async (count: string, size: string) => {
  await openBasicGallery(count, size);
});

When(
  'I go to the {string} basic gallery with {string} {string} images',
  async (mode: string, count: string, size: string) => {
    await openBasicGallery(count, size, { mode });
  },
);

When(
  'I go to the {string} absolutely positioned basic gallery with {string} {string} images',
  async (mode: string, count: string, size: string) => {
    await openBasicGallery(count, size, { mode, absolute: true });
  },
);

Then('I should see {string} images loaded', async (count: string) => {
  const expectedCount = parseInt(count, 10);
  const actualCount = await waitForCount(
    () => getElementCount(Selectors.GALLERY_IMAGE),
    expectedCount,
    'gallery images',
  );
  await expect(actualCount).toBe(expectedCount);
});

Then('the mask overlay should cover the first gallery image', async () => {
  const overlay = await $(Selectors.SEGMENT_OVERLAY).getElement();
  await overlay.waitForExist({ timeout: 5000 });

  const rects = await browser.execute(
    (imgSel: string, overlaySel: string) => {
      const toRect = (el: Element | null) => {
        if (!el) return null;
        const { top, left, width, height } = el.getBoundingClientRect();
        return { top, left, width, height };
      };
      return {
        image: toRect(document.querySelector(imgSel)),
        overlay: toRect(document.querySelector(overlaySel)),
      };
    },
    Selectors.GALLERY_IMAGE,
    Selectors.SEGMENT_OVERLAY,
  );

  expect(rects.image).not.toBeNull();
  expect(rects.overlay).not.toBeNull();
  const { image, overlay: overlayRect } = rects as {
    image: { top: number; left: number; width: number; height: number };
    overlay: { top: number; left: number; width: number; height: number };
  };

  // The anchored image must not have collapsed to 0x0
  expect(image.width).toBeGreaterThan(0);
  expect(image.height).toBeGreaterThan(0);

  const tolerance = 3;
  expect(Math.abs(overlayRect.top - image.top)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(overlayRect.left - image.left)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(overlayRect.width - image.width)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(overlayRect.height - image.height)).toBeLessThanOrEqual(tolerance);
});

Then('I should see {string} mask overlays', async (count: string) => {
  const expectedCount = parseInt(count, 10);
  const getMaskCount = async (): Promise<number> => {
    return getElementCount(Selectors.SEGMENT_OVERLAY);
  };
  const actualCount = await waitForCount(getMaskCount, expectedCount, 'mask overlays');
  expect(actualCount).toBe(expectedCount);
});
