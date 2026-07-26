import { When, Then } from '@wdio/cucumber-framework';

import { Selectors, INFERENCE_TIMEOUT } from '../constants/index.js';
import { isMobile } from '../utils/platform.js';

// Extension timing constants (from quickToggle.ts)
const SHOW_DELAY_MS = 500;

const LIGHTBOX_ID = 'hb-e2e-lightbox';
const LIGHTBOX_IMAGE = `#${LIGHTBOX_ID} img`;

// Eye button geometry (from quickToggle.ts)
const EYE_MARGIN_PX = 8;
const PLACEMENT_TOLERANCE_PX = 2;

When('I open a lightbox over the gallery', async () => {
  await browser.execute(
    (lightboxId: string, imageSelector: string) => {
      const source = globalThis.document.querySelector<HTMLImageElement>(imageSelector);
      if (!source) throw new Error('No gallery image to duplicate into the lightbox');

      const backdrop = globalThis.document.createElement('div');
      backdrop.id = lightboxId;
      // A realistic lightbox z-index, deliberately modest: the eye button must
      // stay beneath the backdrop because it stacks just above its image, not
      // because the backdrop out-bids some huge extension z-index
      backdrop.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.92);
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      const image = globalThis.document.createElement('img');
      image.src = source.currentSrc || source.src;
      image.style.cssText = 'width: 90vw; height: 90vh; object-fit: contain;';

      backdrop.appendChild(image);
      globalThis.document.body.appendChild(backdrop);
    },
    LIGHTBOX_ID,
    Selectors.GALLERY_IMAGE,
  );
});

When('I wait for the lightbox image processing', async () => {
  const image = await $(LIGHTBOX_IMAGE);
  await browser.waitUntil(
    async () => {
      const safe = await image.getAttribute('data-haramblock-processed-safe');
      const unsafe = await image.getAttribute('data-haramblock-processed-unsafe');
      const skipped = await image.getAttribute('data-haramblock-processed-skipped');
      return safe !== null || unsafe !== null || skipped !== null;
    },
    { timeout: INFERENCE_TIMEOUT, timeoutMsg: 'Lightbox image was not processed in time' },
  );
});

When('I hover over the lightbox image', async () => {
  const image = await $(LIGHTBOX_IMAGE);

  if (isMobile()) {
    await image.click();
  } else {
    await image.moveTo();
    // Headless Chrome may not fire pointerenter from moveTo(); dispatch it as backup
    await browser.execute((el: HTMLElement) => {
      el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }));
    }, image);
  }
});

Then('the eye toggle should be inside the lightbox picture', async () => {
  const placement = await browser.execute(
    (imageSelector: string, eyeSelector: string) => {
      const image = globalThis.document.querySelector<HTMLImageElement>(imageSelector);
      const eye = globalThis.document.querySelector<HTMLElement>(eyeSelector);
      if (!image || !eye) return null;

      // Contain-fit picture rect derived from the object-fit spec, independent
      // of the extension's own layout code
      const box = image.getBoundingClientRect();
      const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
      const pictureWidth = image.naturalWidth * scale;
      const pictureHeight = image.naturalHeight * scale;
      const pictureLeft = box.left + (box.width - pictureWidth) / 2;
      const pictureTop = box.top + (box.height - pictureHeight) / 2;

      const eyeRect = eye.getBoundingClientRect();
      return {
        picture: {
          left: pictureLeft,
          top: pictureTop,
          right: pictureLeft + pictureWidth,
          bottom: pictureTop + pictureHeight,
        },
        eye: { left: eyeRect.left, top: eyeRect.top, right: eyeRect.right, bottom: eyeRect.bottom },
      };
    },
    LIGHTBOX_IMAGE,
    Selectors.EYE_TOGGLE,
  );

  expect(placement).not.toBeNull();
  if (!placement) return;
  expect(placement.eye.left).toBeGreaterThanOrEqual(placement.picture.left - PLACEMENT_TOLERANCE_PX);
  expect(placement.eye.top).toBeGreaterThanOrEqual(placement.picture.top - PLACEMENT_TOLERANCE_PX);
  expect(placement.eye.right).toBeLessThanOrEqual(placement.picture.right + PLACEMENT_TOLERANCE_PX);
  expect(placement.eye.bottom).toBeLessThanOrEqual(placement.picture.bottom + PLACEMENT_TOLERANCE_PX);
});

Then('the eye toggle should not be on top at its own position', async () => {
  // Give the show delay a chance to reveal the button if it is going to
  await browser.pause(SHOW_DELAY_MS + 1000);

  const covered = await browser.execute((eyeSelector: string) => {
    const eye = globalThis.document.querySelector<HTMLElement>(eyeSelector);
    if (!eye || !eye.isConnected || globalThis.getComputedStyle(eye).display === 'none') return true;

    const rect = eye.getBoundingClientRect();
    const topElement = globalThis.document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return topElement !== eye && !eye.contains(topElement);
  }, Selectors.EYE_TOGGLE);

  expect(covered).toBe(true);
});

When('I scroll the page by {string} pixels', async (pixels: string) => {
  const delta = parseInt(pixels, 10);
  const target = await browser.execute((dy: number) => {
    globalThis.scrollBy({ top: dy, behavior: 'instant' });
    return globalThis.scrollY;
  }, delta);
  await browser.waitUntil(async () => (await browser.execute(() => globalThis.scrollY)) === target, {
    timeout: 3000,
    timeoutMsg: 'Page did not finish scrolling',
  });
});

Then('the eye toggle should sit at the top-right of the first gallery image', async () => {
  const placement = await browser.execute(
    (imageSelector: string, eyeSelector: string) => {
      const image = globalThis.document.querySelector<HTMLImageElement>(imageSelector);
      const eye = globalThis.document.querySelector<HTMLElement>(eyeSelector);
      if (!image || !eye || globalThis.getComputedStyle(eye).display === 'none') return null;

      const imageRect = image.getBoundingClientRect();
      const eyeRect = eye.getBoundingClientRect();
      return {
        image: { top: imageRect.top, right: imageRect.right },
        eye: { top: eyeRect.top, right: eyeRect.right },
      };
    },
    Selectors.GALLERY_IMAGE,
    Selectors.EYE_TOGGLE,
  );

  expect(placement).not.toBeNull();
  if (!placement) return;
  expect(Math.abs(placement.eye.top - (placement.image.top + EYE_MARGIN_PX))).toBeLessThanOrEqual(
    PLACEMENT_TOLERANCE_PX,
  );
  expect(Math.abs(placement.eye.right - (placement.image.right - EYE_MARGIN_PX))).toBeLessThanOrEqual(
    PLACEMENT_TOLERANCE_PX,
  );
});
