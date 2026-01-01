import { Given, Then } from '@wdio/cucumber-framework';

import { Selectors, INFERENCE_TIMEOUT } from '../constants/gallery.js';

const getElementCount = async (selector: string): Promise<number> => {
  const elements = await $$(selector).getElements();
  return elements.length;
};

/**
 * Set outline type in global settings.
 * Also ensures policy is "process" for AI detection to work.
 */
Given('the outline type is set to {string}', async (outlineType: string) => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);

  // Ensure policy is "process" for AI detection
  const policyButton = await $('[data-testid="policy-toggle"]').getElement();
  const currentPolicy = await policyButton.getAttribute('data-policy');
  if (currentPolicy !== 'process') {
    // Click until we get to "process" (cycles: whitelist -> blacklist -> process)
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      const policy = await policyButton.getAttribute('data-policy');
      if (policy === 'process') break;
      // eslint-disable-next-line no-await-in-loop
      await browser.execute((el: HTMLElement) => el.click(), policyButton);
    }
  }

  // Set outline type
  const buttonText = outlineType === 'bbox' ? 'Bounding box' : 'Segment';
  const button = await $(`button=${buttonText}`).getElement();
  await browser.execute((el: HTMLElement) => el.click(), button);

  await browser.pause(300);
});

Then('I should see at least {string} segment mask overlays with canvas', async (count: string) => {
  const minExpected = parseInt(count, 10);
  const canvasSelector = `${Selectors.SEGMENT_OVERLAY} canvas`;

  try {
    await browser.waitUntil(async () => (await getElementCount(canvasSelector)) >= minExpected, {
      timeout: INFERENCE_TIMEOUT,
      interval: 1000,
    });
  } catch {
    const actualCount = await getElementCount(canvasSelector);
    throw new Error(`Expected at least ${minExpected} segment mask overlays with canvas, but found ${actualCount}`);
  }

  const finalCount = await getElementCount(canvasSelector);
  expect(finalCount).toBeGreaterThanOrEqual(minExpected);
});

Then('I should see at least {string} bounding box overlays', async (count: string) => {
  const minExpected = parseInt(count, 10);

  try {
    await browser.waitUntil(async () => (await getElementCount(Selectors.BBOX_OVERLAY)) >= minExpected, {
      timeout: INFERENCE_TIMEOUT,
    });
  } catch {
    const actualCount = await getElementCount(Selectors.BBOX_OVERLAY);
    throw new Error(`Expected at least ${minExpected} bounding boxes, but found ${actualCount}`);
  }

  const finalCount = await getElementCount(Selectors.BBOX_OVERLAY);
  expect(finalCount).toBeGreaterThanOrEqual(minExpected);
});
