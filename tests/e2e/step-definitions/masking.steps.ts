import { Given, Then } from '@wdio/cucumber-framework';

import { Selectors, INFERENCE_TIMEOUT } from '../constants/index.js';

const getElementCount = async (selector: string): Promise<number> => {
  const elements = await $$(selector);
  return elements.length;
};

const POLICY_SELECTOR = '[data-testid="policy-toggle"]';

const execClick = async (selector: string): Promise<void> => {
  await browser.execute((sel: string) => {
    globalThis.document.querySelector<HTMLElement>(sel)?.click();
  }, selector);
};

const execGetAttr = async (selector: string, attr: string): Promise<string | null> =>
  browser.execute(
    (sel: string, a: string) => globalThis.document.querySelector(sel)?.getAttribute(a) ?? null,
    selector,
    attr,
  );

Given('the outline type is set to {string}', async (outlineType: string) => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);
  await $(POLICY_SELECTOR).waitForDisplayed({ timeout: 15000 });

  await browser.waitUntil(
    async () => {
      const policy = await execGetAttr(POLICY_SELECTOR, 'data-policy');
      if (policy === 'process') return true;
      await execClick(POLICY_SELECTOR);
      return false;
    },
    { timeout: 15000, interval: 500, timeoutMsg: 'Failed to set policy to process' },
  );

  const outlineSelector = `[data-testid="${outlineType === 'bbox' ? 'outline-bbox' : 'outline-segment'}"]`;
  await browser.waitUntil(
    async () => {
      const ready = await browser.execute((sel: string) => {
        const el = globalThis.document.querySelector<HTMLButtonElement>(sel);
        return el !== null && !el.disabled;
      }, outlineSelector);
      return ready;
    },
    { timeout: 5000, timeoutMsg: `Outline control for ${outlineType} was not ready` },
  );
  await execClick(outlineSelector);

  await browser.waitUntil(async () => (await execGetAttr(outlineSelector, 'aria-pressed')) === 'true', {
    timeout: 5000,
    timeoutMsg: `Failed to set outline to ${outlineType}`,
  });
});

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

Then('I should see at least {string} bounding box overlays', async (count: string) => {
  const minExpected = parseInt(count, 10);

  await browser.waitUntil(
    async () => {
      const actualCount = await getElementCount(Selectors.BBOX_OVERLAY);
      return actualCount >= minExpected;
    },
    { timeout: INFERENCE_TIMEOUT, timeoutMsg: `Expected at least ${minExpected} bounding box overlays, but timed out` },
  );
});
