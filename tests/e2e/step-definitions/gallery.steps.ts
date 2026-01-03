import { When, Then } from '@wdio/cucumber-framework';

import {
  buildGalleryUrl,
  GalleryMode,
  Selectors,
  INFERENCE_TIMEOUT,
  type GallerySizeType,
} from '../constants/index.js';

const getElementCount = async (selector: string): Promise<number> => {
  const elements = await $$(selector).getElements();
  return elements.length;
};

const scrollToLoadAllImages = async (): Promise<void> => {
  const footer = await $('footer');
  await footer.waitForExist({ timeout: 5000 });
  await footer.scrollIntoView({ behavior: 'smooth', block: 'end' });
};

When('I go to the basic gallery with {string} {string} images', async (count: string, size: string) => {
  const url = buildGalleryUrl({
    count: parseInt(count, 10),
    size: size as GallerySizeType,
  });
  await browser.url(url);
  await scrollToLoadAllImages();
  const expectedCount = parseInt(count, 10);
  await browser.waitUntil(async () => (await getElementCount(Selectors.GALLERY_IMAGE)) >= expectedCount, {
    timeout: 10000,
    timeoutMsg: `Expected ${count} images to load`,
  });
});

When(
  'I go to the {string} basic gallery with {string} {string} images',
  async (mode: string, count: string, size: string) => {
    const galleryMode = mode === 'safe' ? GalleryMode.SAFE : GalleryMode.NOT_SAFE;
    const url = buildGalleryUrl({
      mode: galleryMode,
      count: parseInt(count, 10),
      size: size as GallerySizeType,
    });
    await browser.url(url);
    await scrollToLoadAllImages();
    const expectedCount = parseInt(count, 10);
    await browser.waitUntil(async () => (await getElementCount(Selectors.GALLERY_IMAGE)) >= expectedCount, {
      timeout: 10000,
      timeoutMsg: `Expected ${count} images to load`,
    });
  },
);

Then('I should see {string} images loaded', async (count: string) => {
  const expectedCount = parseInt(count, 10);
  const actualCount = await getElementCount(Selectors.GALLERY_IMAGE);
  await expect(actualCount).toBe(expectedCount);
});

Then('I should see {string} mask overlays', async (count: string) => {
  const expectedCount = parseInt(count, 10);

  if (expectedCount === 0) {
    const segmentCount = await getElementCount(Selectors.SEGMENT_OVERLAY);
    const bboxCount = await getElementCount(Selectors.BBOX_OVERLAY);
    await expect(segmentCount + bboxCount).toBe(0);
  } else {
    const getTotalOverlays = async (): Promise<number> => {
      const segmentCount = await getElementCount(Selectors.SEGMENT_OVERLAY);
      const bboxCount = await getElementCount(Selectors.BBOX_OVERLAY);
      return segmentCount + bboxCount;
    };

    try {
      await browser.waitUntil(async () => (await getTotalOverlays()) >= expectedCount, {
        timeout: INFERENCE_TIMEOUT,
      });
    } catch {
      const actualCount = await getTotalOverlays();
      throw new Error(`Expected ${expectedCount} mask overlays, but found ${actualCount}`);
    }
  }
});
