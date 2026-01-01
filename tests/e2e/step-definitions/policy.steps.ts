import { Given, Then } from '@wdio/cucumber-framework';

import { Selectors, INFERENCE_TIMEOUT } from '../constants/gallery.js';

const VALID_POLICIES = ['whitelist', 'blacklist', 'process'];

const checkAllImagesBlacklisted = async (): Promise<boolean> => {
  const images = await $$(Selectors.GALLERY_IMAGE).getElements();
  if (images.length === 0) return false;

  const results = await Promise.all(Array.from(images).map(img => img.getAttribute(Selectors.BLACKLIST_ATTR)));
  return results.every(attr => attr !== null);
};

const clickUntilPolicy = async (
  policyButton: WebdriverIO.Element,
  targetPolicy: string,
  maxClicks: number,
): Promise<void> => {
  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < maxClicks; i++) {
    const currentPolicy = await policyButton.getAttribute('data-policy');
    if (currentPolicy === targetPolicy) {
      return;
    }
    // Use JS click to avoid "element click intercepted" errors from child elements
    await browser.execute((el: HTMLElement) => el.click(), policyButton);
    // Wait for React state to settle after click
    await browser.pause(500);
  }
  /* eslint-enable no-await-in-loop */

  // Final verification that policy was set
  const finalPolicy = await policyButton.getAttribute('data-policy');
  if (finalPolicy !== targetPolicy) {
    throw new Error(`Failed to set policy to "${targetPolicy}". Current policy: "${finalPolicy}"`);
  }
};

/**
 * Set global policy before navigating to test page.
 * This ensures the policy is active when the content script loads.
 */
Given('I set the global policy to {string}', async (policy: string) => {
  if (!VALID_POLICIES.includes(policy)) {
    throw new Error(`Unknown policy: ${policy}. Valid policies: ${VALID_POLICIES.join(', ')}`);
  }

  const extensionPath = await browser.getExtensionPath();
  // Open popup directly - it will show global settings by default
  await browser.url(`${extensionPath}/popup.html`);

  const policyButton = await $('[data-testid="policy-toggle"]').getElement();
  await clickUntilPolicy(policyButton, policy, 3);

  await browser.pause(500);
});

Then('all images should be blacklisted', async () => {
  await browser.waitUntil(checkAllImagesBlacklisted, {
    timeout: INFERENCE_TIMEOUT,
    timeoutMsg: 'Expected all images to be blacklisted',
  });
});
