import { Given, When, Then } from '@wdio/cucumber-framework';

import { Selectors, INFERENCE_TIMEOUT } from '../constants/index.js';
import { isMobile } from '../utils/platform.js';

// Extension timing constants (from quickToggle.ts)
const SHOW_DELAY_MS = 500;
const HIDE_DELAY_MS = 2500;

const setQuickToggleState = async (
  toggleRow: WebdriverIO.Element,
  checkbox: WebdriverIO.Element,
  enabled: boolean,
): Promise<void> => {
  const isChecked = await checkbox.getProperty('checked');
  if (isChecked === enabled) return;

  const label = await toggleRow.$('label');
  await label.click();
  await browser.waitUntil(async () => (await checkbox.getProperty('checked')) === enabled, {
    timeout: 5000,
    timeoutMsg: `Failed to set quick toggle to ${enabled}`,
  });
};

const waitForScrollToSettle = async (): Promise<void> => {
  let lastScrollX = -1;
  let lastScrollY = -1;
  let stablePolls = 0;

  await browser.waitUntil(
    async () => {
      const { scrollX, scrollY } = await browser.execute(() => ({
        scrollX: globalThis.scrollX,
        scrollY: globalThis.scrollY,
      }));
      if (scrollX === lastScrollX && scrollY === lastScrollY) {
        stablePolls += 1;
      } else {
        stablePolls = 0;
        lastScrollX = scrollX;
        lastScrollY = scrollY;
      }
      return stablePolls >= 2;
    },
    { timeout: 5000, interval: 100, timeoutMsg: 'Page scroll did not settle' },
  );
};

Given('quick toggle {string} is {string}', async (type: string, state: string) => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);

  const testId = type === 'unsafe' ? 'quick-toggle-unsafe' : 'quick-toggle-safe';
  const toggleRow = await $(`[data-testid="${testId}"]`);
  await toggleRow.waitForDisplayed({ timeout: 5000 });

  const checkbox = await toggleRow.$('input[type="checkbox"]');
  await checkbox.waitForExist({ timeout: 5000 });

  await browser.waitUntil(async () => !(await checkbox.getProperty('disabled')), {
    timeout: 5000,
    timeoutMsg: 'Quick toggle checkbox is still disabled',
  });

  const isChecked = await checkbox.getProperty('checked');
  const enabled = state === 'enabled';
  if (isChecked === enabled) {
    await setQuickToggleState(toggleRow, checkbox, !enabled);
  }
  await setQuickToggleState(toggleRow, checkbox, enabled);

  // Wait for IndexedDB write to propagate to background context.
  // The content script reads settings once at page load via background RPC.
  // If the write hasn't committed across contexts, the content script gets stale
  // settings and never registers the quick toggle (eyeButton won't exist in DOM).
  await browser.pause(2000);
});

When('I wait for image processing', async () => {
  const image = await $(Selectors.GALLERY_IMAGE);
  await browser.waitUntil(
    async () => {
      const safe = await image.getAttribute('data-haramblock-processed-safe');
      const unsafe = await image.getAttribute('data-haramblock-processed-unsafe');
      const skipped = await image.getAttribute('data-haramblock-processed-skipped');
      const blacklisted = await image.getAttribute(Selectors.BLACKLIST_ATTR);
      return safe !== null || unsafe !== null || skipped !== null || blacklisted !== null;
    },
    { timeout: INFERENCE_TIMEOUT, timeoutMsg: 'Image was not processed in time' },
  );
});

When('I hover over the first gallery image', async () => {
  const image = await $(Selectors.GALLERY_IMAGE);
  await image.scrollIntoView({ block: 'center' });
  // The extension's scroll listener hides the eye button and cancels pending show timers.
  // Hover only after scrolling has fully settled.
  await waitForScrollToSettle();

  if (isMobile()) {
    // Mobile has no hover — a tap on the image triggers the quick toggle eye icon
    await image.click();
  } else {
    await image.moveTo();
    // Headless Chrome may not fire pointerenter from moveTo(); dispatch it as backup
    await browser.execute((el: HTMLElement) => {
      el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }));
    }, image);
  }
});

When('I wait for the eye toggle to auto-hide', async () => {
  // Wait longer than the extension's HIDE_DELAY_MS (2500ms)
  await browser.pause(HIDE_DELAY_MS + 1000);
});

Then('I should see the eye toggle icon', async () => {
  const eyeToggle = await $(Selectors.EYE_TOGGLE);
  // Allow enough time for the 500ms show delay
  await eyeToggle.waitForDisplayed({
    timeout: SHOW_DELAY_MS + 5000,
    timeoutMsg: 'Expected eye toggle to be visible',
  });
});

Then('I should not see the eye toggle icon', async () => {
  const eyeToggle = await $(Selectors.EYE_TOGGLE);
  const exists = await eyeToggle.isExisting();
  if (!exists) return; // element not in DOM — not visible

  await eyeToggle.waitForDisplayed({
    timeout: 3000,
    reverse: true,
    timeoutMsg: 'Expected eye toggle to be hidden',
  });
});

When('I click the eye toggle icon', async () => {
  const eyeToggle = await $(Selectors.EYE_TOGGLE);
  await eyeToggle.waitForDisplayed({
    timeout: SHOW_DELAY_MS + 5000,
    timeoutMsg: 'Eye toggle not visible for click',
  });
  await eyeToggle.click();
});

Then('the first image should be masked', async () => {
  await browser.waitUntil(
    async () => {
      const overlays = await $$(Selectors.SEGMENT_OVERLAY);
      const bboxes = await $$(Selectors.BBOX_OVERLAY);
      return overlays.length > 0 || bboxes.length > 0;
    },
    { timeout: 5000, timeoutMsg: 'Expected image to be masked' },
  );
});

Then('the first image should not be masked', async () => {
  await browser.waitUntil(
    async () => {
      const overlays = await $$(Selectors.SEGMENT_OVERLAY);
      const bboxes = await $$(Selectors.BBOX_OVERLAY);
      return overlays.length === 0 && bboxes.length === 0;
    },
    { timeout: 5000, timeoutMsg: 'Expected image to not be masked' },
  );
});

Then('the first image should be blacklisted', async () => {
  const image = await $(Selectors.GALLERY_IMAGE);
  await browser.waitUntil(async () => (await image.getAttribute(Selectors.BLACKLIST_ATTR)) !== null, {
    timeout: 5000,
    timeoutMsg: 'Expected image to be blacklisted',
  });
});

Then('the first image should not be blacklisted', async () => {
  const image = await $(Selectors.GALLERY_IMAGE);
  const attr = await image.getAttribute(Selectors.BLACKLIST_ATTR);
  expect(attr).toBeNull();
});
