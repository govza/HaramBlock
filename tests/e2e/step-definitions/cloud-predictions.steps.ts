import { Given, Then } from '@wdio/cucumber-framework';

import { readCachedImageRows, readStoredConsent } from '../utils/cloud-predictions.js';

const CONSENT_BUTTONS: Record<string, string> = {
  Agree: '[data-testid="consent-agree"]',
  'Not now': '[data-testid="consent-not-now"]',
};
const SECTION = '[data-testid="cloud-predictions"]';
const SWITCH_CHECKBOX = '[data-testid="cloud-predictions-switch"] input[type="checkbox"]';
const SWITCH_LABEL = '[data-testid="cloud-predictions-switch"] label';
const INSTALL_ID = '[data-testid="cloud-predictions-install-id"]';
const ERASURE_LINK = '[data-testid="cloud-predictions-erasure-link"]';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATE_TIMEOUT_MS = 5000;

let testWindow: string | undefined;
let consentWindow: string | undefined;
let shownInstallId: string | undefined;

Given('I open the Cloud Predictions consent tab', async () => {
  const extensionPath = await browser.getExtensionPath();
  testWindow = await browser.getWindowHandle();
  const { handle } = await browser.createWindow('tab');
  consentWindow = handle;
  await browser.switchToWindow(handle);
  await browser.url(`${extensionPath}/consent.html`);
  await $('[data-testid="consent-tab"]').waitForDisplayed({ timeout: 15000 });
});

Given('I answer {string} on the consent tab', async (answer: string) => {
  const selector = CONSENT_BUTTONS[answer];
  if (!selector) throw new Error(`Unknown consent answer: ${answer}`);
  const button = await $(selector).getElement();
  await button.click();
});

Given('the consent tab closes', async () => {
  if (!consentWindow || !testWindow) throw new Error('The consent tab was not opened by this scenario');
  const closedWindow = consentWindow;
  await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(closedWindow), {
    timeout: STATE_TIMEOUT_MS,
    timeoutMsg: 'The consent tab stayed open after answering',
  });
  await browser.switchToWindow(testWindow);
  consentWindow = undefined;
});

Given('the Cloud Predictions consent is {string}', async (expected: string) => {
  let stored = '';
  await browser
    .waitUntil(
      async () => {
        stored = await readStoredConsent();
        return stored === expected;
      },
      { timeout: STATE_TIMEOUT_MS },
    )
    .catch(() => {
      throw new Error(`Expected Cloud Predictions consent "${expected}", stored "${stored}"`);
    });
});

Then('no cached image prediction is reported', async () => {
  const rows = await readCachedImageRows();
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.filter(row => row.reportStatus === 'reported')).toEqual([]);
});

Given('I open the Cloud Predictions options section', async () => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/options.html`);
  const tab = await $('[data-testid="options-tab-cloudPredictions"]').getElement();
  await tab.waitForDisplayed({ timeout: 15000 });
  await tab.click();
  await $(SECTION).waitForDisplayed({ timeout: STATE_TIMEOUT_MS });
});

Then('the Cloud Predictions section shows {string}', async (expected: string) => {
  const section = await $(SECTION).getElement();
  await browser.waitUntil(async () => (await section.getAttribute('data-state')) === expected, {
    timeout: STATE_TIMEOUT_MS,
    timeoutMsg: `Expected the Cloud Predictions section to show "${expected}"`,
  });
});

Given('I switch Cloud Predictions {string}', async (target: string) => {
  if (target !== 'on' && target !== 'off') throw new Error(`Unknown switch position: ${target}`);
  const shouldBeOn = target === 'on';
  const checkbox = await $(SWITCH_CHECKBOX).getElement();
  if ((await checkbox.getProperty('checked')) !== shouldBeOn) {
    const label = await $(SWITCH_LABEL).getElement();
    await label.click();
  }
  await browser.waitUntil(async () => (await checkbox.getProperty('checked')) === shouldBeOn, {
    timeout: STATE_TIMEOUT_MS,
    timeoutMsg: `Failed to switch Cloud Predictions ${target}`,
  });
});

Then('no Install ID is shown', async () => {
  await expect($(INSTALL_ID)).not.toBeExisting();
});

const readDisplayedInstallId = async (): Promise<string> => {
  const installId = await $(INSTALL_ID).getElement();
  await installId.waitForDisplayed({ timeout: STATE_TIMEOUT_MS });
  return (await installId.getText()).trim();
};

Then('the Install ID is shown', async () => {
  shownInstallId = await readDisplayedInstallId();
  expect(shownInstallId).toMatch(UUID_PATTERN);
});

Then('the Install ID is still the same', async () => {
  expect(await readDisplayedInstallId()).toBe(shownInstallId);
});

Then('the deletion email carries the Install ID', async () => {
  if (!shownInstallId) throw new Error('No Install ID was read in this scenario');
  const link = await $(ERASURE_LINK).getElement();
  const href = (await link.getAttribute('href')) ?? '';
  expect(href.startsWith('mailto:')).toBe(true);
  expect(href).toContain(shownInstallId);
});
