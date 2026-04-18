import { BeforeAll } from '@wdio/cucumber-framework';

import { isMobile } from '../utils/platform.js';

const IS_CI = Boolean(process.env.CI) || process.argv.includes('--debug');

const setPolicyProcess = async (): Promise<void> => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);
  await $('[data-testid="policy-toggle"]').waitForDisplayed({ timeout: 15000 });

  const policyButton = await $('[data-testid="policy-toggle"]');
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    const current = await policyButton.getAttribute('data-policy');
    if (current === 'process') break;
    // eslint-disable-next-line no-await-in-loop
    await policyButton.click();
    // eslint-disable-next-line no-await-in-loop
    await browser.pause(300);
  }
};

BeforeAll(async () => {
  if (!IS_CI || isMobile()) return;

  try {
    await setPolicyProcess();
    await browser.pause(10_000);
  } catch (err) {
    // Best-effort warmup; don't fail the run if warmup fails.
    console.warn('Warmup skipped/failed:', (err as Error)?.message ?? err);
  }
});
