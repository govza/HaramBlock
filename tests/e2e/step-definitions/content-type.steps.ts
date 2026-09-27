import { Given, Then } from '@wdio/cucumber-framework';

import { formatCapturedLogs, getCapturedLogs, startCapturingExtensionLogs } from '../utils/console-capture.js';

Given('I start capturing extension console errors', () => {
  startCapturingExtensionLogs();
});

Then('there should be no HaramBlock console errors', async () => {
  await browser.pause(2000);
  const errors = getCapturedLogs().filter(e => e.level === 'error');
  if (errors.length > 0) {
    throw new Error(`Unexpected HaramBlock console errors: ${formatCapturedLogs()}`);
  }
});

Then('the content script should have initialized', async () => {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        return document.getElementById('haramblock-prediction-styles') !== null;
      }),
    {
      timeout: 30000,
      interval: 500,
      timeoutMsg: 'Content script did not inject prediction styles within 30s',
    },
  );
});
