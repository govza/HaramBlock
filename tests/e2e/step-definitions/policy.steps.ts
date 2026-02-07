import { Given, Then } from '@wdio/cucumber-framework';

import { Selectors } from '../constants/index.js';

const VALID_POLICIES = ['whitelist', 'blacklist', 'process', 'process-images'];

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
  const policiesSeen: string[] = [];

  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < maxClicks; i++) {
    const currentPolicy = await policyButton.getAttribute('data-policy');
    policiesSeen.push(currentPolicy ?? 'null');
    if (currentPolicy === targetPolicy) {
      return;
    }
    await browser.execute((el: HTMLElement) => el.click(), policyButton);
    await browser.pause(500);
  }
  /* eslint-enable no-await-in-loop */

  const finalPolicy = await policyButton.getAttribute('data-policy');
  policiesSeen.push(finalPolicy ?? 'null');
  if (finalPolicy !== targetPolicy) {
    throw new Error(
      `Failed to set policy to "${targetPolicy}" after ${maxClicks} clicks. ` +
        `Policy sequence: [${policiesSeen.join(' → ')}]`,
    );
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
  await clickUntilPolicy(policyButton, policy, 4);

  await browser.pause(500);
});

Then('all images should be blacklisted', async () => {
  const isBlacklisted = await checkAllImagesBlacklisted();
  expect(isBlacklisted).toBe(true);
});
