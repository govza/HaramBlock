import { Given, When, Then } from '@wdio/cucumber-framework';

import { Selectors, Timeouts, INFERENCE_TIMEOUT } from '../constants/index.js';

const setQuickToggle = async (type: 'safe' | 'unsafe', enabled: boolean): Promise<void> => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);

  const testId = type === 'unsafe' ? 'quick-toggle-unsafe' : 'quick-toggle-safe';
  const toggleRow = await $(`[data-testid="${testId}"]`).getElement();
  await toggleRow.waitForDisplayed({ timeout: 5000 });

  const checkbox = await toggleRow.$('input[type="checkbox"]').getElement();
  await checkbox.waitForExist({ timeout: 5000 });

  // Wait for toggle to be enabled (policy must be 'process')
  await browser.waitUntil(
    async () => {
      const isDisabled = await browser.execute((el: HTMLInputElement) => el.disabled, checkbox);
      return !isDisabled;
    },
    { timeout: 5000, timeoutMsg: 'Quick toggle checkbox is still disabled' },
  );

  const getCheckedState = async (): Promise<boolean> => {
    return browser.execute((el: HTMLInputElement) => el.checked, checkbox);
  };

  const isChecked = await getCheckedState();
  if (isChecked !== enabled) {
    const label = await toggleRow.$('label').getElement();
    await browser.execute((el: HTMLElement) => el.click(), label);
    await browser.waitUntil(async () => (await getCheckedState()) === enabled, {
      timeout: 5000,
      timeoutMsg: `Failed to set quick toggle ${type} to ${enabled}`,
    });
  }
};

Given('quick toggle {string} is {string}', async (type: string, state: string) => {
  const toggleType = type as 'safe' | 'unsafe';
  const enabled = state === 'enabled';
  await setQuickToggle(toggleType, enabled);
});

When('I wait for image processing', async () => {
  const image = await $(Selectors.GALLERY_IMAGE).getElement();
  await browser.waitUntil(
    async () => {
      const safe = await image.getAttribute('data-haramblock-processed-safe');
      const unsafe = await image.getAttribute('data-haramblock-processed-unsafe');
      const skipped = await image.getAttribute('data-haramblock-processed-skipped');
      return safe !== null || unsafe !== null || skipped !== null;
    },
    { timeout: INFERENCE_TIMEOUT, timeoutMsg: 'Image was not processed in time' },
  );
});

When('I hover over the first gallery image', async () => {
  const image = await $(Selectors.GALLERY_IMAGE).getElement();
  await image.scrollIntoView({ block: 'center' });
  await browser.pause(Timeouts.SCROLL_SETTLE);
  await browser.execute((el: HTMLImageElement) => {
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
  }, image);
});

When('I wait for the eye toggle to auto-hide', async () => {
  await browser.pause(Timeouts.EYE_TOGGLE_AUTO_HIDE);
});

Then('I should see the eye toggle icon', async () => {
  const eyeToggle = await $(Selectors.EYE_TOGGLE).getElement();
  await eyeToggle.waitForDisplayed({ timeout: INFERENCE_TIMEOUT });
});

Then('I should not see the eye toggle icon', async () => {
  const eyeToggle = await $(Selectors.EYE_TOGGLE).getElement();
  const exists = await eyeToggle.isExisting();
  if (exists) {
    await browser.waitUntil(async () => !(await eyeToggle.isDisplayed()), {
      timeout: 2000,
      timeoutMsg: 'Expected eye toggle to be hidden',
    });
  }
});
