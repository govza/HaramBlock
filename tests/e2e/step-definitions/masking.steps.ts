import { Then } from '@wdio/cucumber-framework';

import { Selectors, INFERENCE_TIMEOUT } from '../constants/index.js';

const getElementCount = async (selector: string): Promise<number> => {
  const elements = await $$(selector);
  return elements.length;
};

Then('I should see at least {string} segment mask overlays with canvas', async (count: string) => {
  const minExpected = parseInt(count, 10);
  const canvasSelector = `${Selectors.SEGMENT_OVERLAY} canvas`;

  await browser.waitUntil(
    async () => {
      const actualCount = await getElementCount(canvasSelector);
      return actualCount >= minExpected;
    },
    { timeout: INFERENCE_TIMEOUT, timeoutMsg: `Expected at least ${minExpected} segment mask overlays, but timed out` },
  );
});
