import { Given, Then } from '@wdio/cucumber-framework';

import { Selectors } from '../constants/index.js';

const getElementCount = async (selector: string): Promise<number> => {
  const elements = await $$(selector);
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
  const policyButton = await $('[data-testid="policy-toggle"]');
  const currentPolicy = await policyButton.getAttribute('data-policy');
  if (currentPolicy !== 'process') {
    // Click until we get to "process" (cycles: whitelist -> blacklist -> process)
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      const policy = await policyButton.getAttribute('data-policy');
      if (policy === 'process') break;
      // eslint-disable-next-line no-await-in-loop
      await policyButton.click();
    }
  }

  // Set outline type and wait for selected state (class reflects selection)
  const testId = outlineType === 'bbox' ? 'outline-bbox' : 'outline-segment';
  const button = await $(`[data-testid="${testId}"]`);
  await button.click();

  await browser.waitUntil(
    async () => {
      const pressed = await button.getAttribute('aria-pressed');
      return pressed === 'true';
    },
    { timeout: 5000, timeoutMsg: `Failed to set outline to ${outlineType}` },
  );
});

Then('I should see at least {string} segment mask overlays with canvas', async (count: string) => {
  const minExpected = parseInt(count, 10);
  const canvasSelector = `${Selectors.SEGMENT_OVERLAY} canvas`;

  await browser.waitUntil(
    async () => {
      const actualCount = await getElementCount(canvasSelector);
      return actualCount >= minExpected;
    },
    { timeout: 30000, timeoutMsg: `Expected at least ${minExpected} segment mask overlays, but timed out` },
  );
});

Then('I should see at least {string} bounding box overlays', async (count: string) => {
  const minExpected = parseInt(count, 10);

  await browser.waitUntil(
    async () => {
      const actualCount = await getElementCount(Selectors.BBOX_OVERLAY);
      return actualCount >= minExpected;
    },
    { timeout: 30000, timeoutMsg: `Expected at least ${minExpected} bounding box overlays, but timed out` },
  );
});
